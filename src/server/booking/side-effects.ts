import "server-only";
import type { Db } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import type { JobPayloads } from "@/server/jobs/kinds";
import { env } from "@/server/env";
import { encryptSecret } from "@/server/crypto/aes";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import type { ResolvedEventType } from "@/server/scheduling";

/**
 * Outbox writes for booking changes. Every function here must run inside the transaction
 * that changes the booking, so the jobs exist only if the change commits.
 *
 * Idempotency keys (unique per job kind):
 *   graph_event_upsert  <bookingId>:upsert[:<suffix>]
 *   graph_event_delete  <bookingId>:delete:<userId>
 *   email_send          <bookingId>:confirmed | :rescheduled[:<suffix>] | :cancelled
 *                       <bookingId>:reminder:<offsetMin>
 *                       <bookingId>:host_notice:<event>:<userId>
 *   sf_lead_create      <bookingId>
 */

export type ManageToken = { token: string; hash: string; encrypted: string };

/** A fresh 32-byte manage token, its SHA-256 lookup hash, and an encrypted copy for emails. */
export function issueManageToken(bookingId: string): ManageToken {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token), encrypted: encryptSecret(token, bookingId) };
}

type EmailPayload = JobPayloads["email_send"];

async function enqueueEmail(db: Db, payload: EmailPayload, key: string, runAt?: Date): Promise<void> {
  await enqueue(db, { kind: "email_send", payload, idempotencyKey: key, bookingId: payload.bookingId, runAt });
}

export async function enqueueGraphUpsert(db: Db, bookingId: string, suffix?: string): Promise<void> {
  const payload: JobPayloads["graph_event_upsert"] = { bookingId };
  await enqueue(db, {
    kind: "graph_event_upsert",
    payload,
    idempotencyKey: suffix ? `${bookingId}:upsert:${suffix}` : `${bookingId}:upsert`,
    bookingId,
  });
}

export async function enqueueGraphDelete(
  db: Db,
  bookingId: string,
  host: { userId: string; graphEventId: string | null },
): Promise<void> {
  const payload: JobPayloads["graph_event_delete"] = { bookingId, userId: host.userId, graphEventId: host.graphEventId };
  await enqueue(db, {
    kind: "graph_event_delete",
    payload,
    idempotencyKey: `${bookingId}:delete:${host.userId}`,
    bookingId,
  });
}

/** One reminder per offset at start - offset. Offsets whose time has passed are skipped. */
export async function enqueueReminders(
  db: Db,
  bookingId: string,
  startMs: number,
  offsetsMin: number[],
  now = Date.now(),
): Promise<void> {
  for (const offset of [...new Set(offsetsMin)].filter((o) => Number.isInteger(o) && o > 0)) {
    const runAt = startMs - offset * 60_000;
    if (runAt <= now) continue;
    await enqueueEmail(
      db,
      { template: "booking_reminder", bookingId, recipient: "invitee", offsetMin: offset },
      `${bookingId}:reminder:${offset}`,
      new Date(runAt),
    );
  }
}

/** Marks pending reminder jobs for a booking as dead (used on cancel and reschedule). */
export async function cancelPendingReminders(db: Db, bookingId: string): Promise<number> {
  const rows = await db`
    update app.jobs set status = 'dead', last_error = 'booking cancelled', locked_until = null
    where booking_id = ${bookingId} and kind = 'email_send'
      and status in ('pending', 'failed')
      and payload ->> 'template' = 'booking_reminder'
    returning id
  `;
  return rows.length;
}

/** host_booking_notice for hosts who opted in (user_settings.notify_host_by_email). */
export async function enqueueHostNotices(db: Db, bookingId: string, userIds: string[], event: string): Promise<void> {
  if (!userIds.length) return;
  const rows = await db<{ user_id: string }[]>`
    select user_id from app.user_settings where user_id = any(${userIds}::uuid[]) and notify_host_by_email
  `;
  for (const r of rows) {
    await enqueueEmail(
      db,
      { template: "host_booking_notice", bookingId, recipient: { userId: r.user_id } },
      `${bookingId}:host_notice:${event}:${r.user_id}`,
    );
  }
}

/**
 * Enqueues Salesforce lead creation when the EFFECTIVE settings (after variant
 * inheritance) enable it, and marks the booking's lead status as pending.
 *
 * The settings come from resolveVariant (computed once for the booking), which applies
 * the same inheritance rule as getEffectiveSfSettings in src/server/salesforce/settings.ts.
 */
export async function enqueueSfLeadIfEnabled(
  db: Db,
  bookingId: string,
  resolved: Pick<ResolvedEventType, "sfSettings">,
): Promise<boolean> {
  if (!resolved.sfSettings?.create_sf_lead) return false;
  await db`update app.bookings set sf_lead_status = 'pending' where id = ${bookingId} and sf_lead_id is null`;
  const payload: JobPayloads["sf_lead_create"] = { bookingId };
  await enqueue(db, {
    kind: "sf_lead_create",
    payload,
    idempotencyKey: bookingId,
    bookingId,
    maxAttempts: env().SF_LEAD_MAX_ATTEMPTS,
  });
  return true;
}

/** Jobs for a newly confirmed booking (not a reschedule). */
export async function enqueueBookingCreated(
  db: Db,
  input: {
    bookingId: string;
    startMs: number;
    reminderOffsetsMin: number[];
    hostUserIds: string[];
    resolved: Pick<ResolvedEventType, "sfSettings">;
    now?: number;
  },
): Promise<void> {
  const { bookingId } = input;
  await enqueueGraphUpsert(db, bookingId);
  await enqueueEmail(db, { template: "booking_confirmed", bookingId, recipient: "invitee" }, `${bookingId}:confirmed`);
  await enqueueReminders(db, bookingId, input.startMs, input.reminderOffsetsMin, input.now);
  await enqueueHostNotices(db, bookingId, input.hostUserIds, "created");
  await enqueueSfLeadIfEnabled(db, bookingId, input.resolved);
}

/** Jobs for a reschedule: old events removed, new booking created, no new Salesforce lead. */
export async function enqueueBookingRescheduled(
  db: Db,
  input: {
    oldBookingId: string;
    newBookingId: string;
    oldHosts: { userId: string; graphEventId: string | null }[];
    newStartMs: number;
    reminderOffsetsMin: number[];
    hostUserIds: string[];
    now?: number;
  },
): Promise<void> {
  for (const h of input.oldHosts) await enqueueGraphDelete(db, input.oldBookingId, h);
  await cancelPendingReminders(db, input.oldBookingId);
  await enqueueGraphUpsert(db, input.newBookingId);
  await enqueueEmail(
    db,
    { template: "booking_rescheduled", bookingId: input.newBookingId, recipient: "invitee" },
    `${input.newBookingId}:rescheduled`,
  );
  await enqueueReminders(db, input.newBookingId, input.newStartMs, input.reminderOffsetsMin, input.now);
  await enqueueHostNotices(db, input.newBookingId, input.hostUserIds, "rescheduled");
}

/** Jobs for an invitee cancellation. The Salesforce lead is left untouched. */
export async function enqueueBookingCancelled(
  db: Db,
  input: { bookingId: string; hosts: { userId: string; graphEventId: string | null }[] },
): Promise<void> {
  for (const h of input.hosts) await enqueueGraphDelete(db, input.bookingId, h);
  await cancelPendingReminders(db, input.bookingId);
  await enqueueEmail(
    db,
    { template: "booking_cancelled", bookingId: input.bookingId, recipient: "invitee" },
    `${input.bookingId}:cancelled`,
  );
  await enqueueHostNotices(db, input.bookingId, input.hosts.map((h) => h.userId), "cancelled");
}

