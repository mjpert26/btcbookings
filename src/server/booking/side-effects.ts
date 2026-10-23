import "server-only";
import type { Db } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import type { JobPayloads } from "@/server/jobs/kinds";
import { env } from "@/server/env";
import { encryptSecret } from "@/server/crypto/aes";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import type { ResolvedEventType } from "@/server/scheduling";
import { enqueueSfLeadOnReschedule } from "@/server/salesforce/jobs";

/**
 * Outbox writes for booking changes. Every function here must run inside the transaction
 * that changes the booking, so the jobs exist only if the change commits.
 *
 * Idempotency keys (unique per job kind):
 *   graph_event_upsert  <bookingId>:upsert[:<suffix>]
 *   graph_event_delete  <bookingId>:delete:<userId>[:<suffix>]
 *   email_send          <bookingId>:confirmed | :rescheduled[:<suffix>] | :cancelled
 *                       <bookingId>:reminder:<offsetMin>                 (merchant reminder)
 *                       <bookingId>:host_reminder:<userId>:<offsetMin>[:<suffix>]   (agent reminder)
 *                       <bookingId>:host_notice:<event>:<userId>
 *   sms_send            <bookingId>:sms:invitee:<offsetMin> | <bookingId>:sms:<userId>:<offsetMin>[:<suffix>]
 *   slack_dm_send       <bookingId>:slack_dm:<userId>:<offsetMin>[:<suffix>]
 *   sf_lead_create      <bookingId> (a new booking, or the new booking of a reschedule)
 *
 * A host reassignment (booking/jobs.ts) adds its booking_reassign job id as the suffix to
 * every key it enqueues (and to the host_notice event), so a booking that returns to a
 * previous host gets new jobs instead of colliding with that host's earlier, cancelled ones.
 *
 * Every reminder job carries payload.bookingId and booking_id, so the
 * jobs_skip_imported_bookings trigger drops them for imported bookings.
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
  suffix?: string,
): Promise<void> {
  const payload: JobPayloads["graph_event_delete"] = { bookingId, userId: host.userId, graphEventId: host.graphEventId };
  const key = `${bookingId}:delete:${host.userId}`;
  await enqueue(db, {
    kind: "graph_event_delete",
    payload,
    idempotencyKey: suffix ? `${key}:${suffix}` : key,
    bookingId,
  });
}

export type MerchantReminderChannel = "email" | "sms";
export type AgentReminderChannel = "email" | "slack" | "sms";

/** Per booking page reminder settings (app.event_types reminder columns). */
export type ReminderSettings = {
  /** reminder_offsets_min */
  merchantOffsetsMin: number[];
  /** merchant_reminder_channels */
  merchantChannels: MerchantReminderChannel[];
  /** agent_reminder_channels */
  agentChannels: AgentReminderChannel[];
  /** agent_reminder_offsets_min */
  agentOffsetsMin: number[];
};

/** Column defaults: merchant email reminders only, as before agent and SMS reminders existed. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  merchantOffsetsMin: [1440, 60],
  merchantChannels: ["email"],
  agentChannels: [],
  agentOffsetsMin: [15],
};

/** Reminder settings of the booking's own event type row. */
export async function loadReminderSettings(db: Db, bookingId: string): Promise<ReminderSettings> {
  const [row] = await db<
    {
      reminder_offsets_min: number[];
      merchant_reminder_channels: string[];
      agent_reminder_channels: string[];
      agent_reminder_offsets_min: number[];
    }[]
  >`
    select e.reminder_offsets_min, e.merchant_reminder_channels, e.agent_reminder_channels, e.agent_reminder_offsets_min
    from app.bookings b join app.event_types e on e.id = b.event_type_id
    where b.id = ${bookingId}
  `;
  if (!row) return { ...DEFAULT_REMINDER_SETTINGS, merchantChannels: [], agentChannels: [] };
  return {
    merchantOffsetsMin: row.reminder_offsets_min,
    merchantChannels: row.merchant_reminder_channels.filter((c): c is MerchantReminderChannel => c === "email" || c === "sms"),
    agentChannels: row.agent_reminder_channels.filter((c): c is AgentReminderChannel => c === "email" || c === "slack" || c === "sms"),
    agentOffsetsMin: row.agent_reminder_offsets_min,
  };
}

/** Distinct positive offsets whose send time (start - offset) is still in the future. */
function dueOffsets(startMs: number, offsetsMin: number[], now: number): { offset: number; runAt: Date }[] {
  return [...new Set(offsetsMin)]
    .filter((o) => Number.isInteger(o) && o > 0)
    .map((offset) => ({ offset, runAt: startMs - offset * 60_000 }))
    .filter((r) => r.runAt > now)
    .map((r) => ({ offset: r.offset, runAt: new Date(r.runAt) }));
}

/** One merchant email reminder per offset at start - offset. Offsets whose time has passed are skipped. */
export async function enqueueReminders(
  db: Db,
  bookingId: string,
  startMs: number,
  offsetsMin: number[],
  now = Date.now(),
): Promise<void> {
  for (const { offset, runAt } of dueOffsets(startMs, offsetsMin, now)) {
    await enqueueEmail(
      db,
      { template: "booking_reminder", bookingId, recipient: "invitee", offsetMin: offset },
      `${bookingId}:reminder:${offset}`,
      runAt,
    );
  }
}

/** Merchant text reminders at the merchant offsets. */
async function enqueueMerchantSms(db: Db, bookingId: string, startMs: number, offsetsMin: number[], now: number): Promise<void> {
  for (const { offset, runAt } of dueOffsets(startMs, offsetsMin, now)) {
    const payload: JobPayloads["sms_send"] = { template: "booking_reminder", bookingId, recipient: "invitee", offsetMin: offset };
    await enqueue(db, { kind: "sms_send", payload, idempotencyKey: `${bookingId}:sms:invitee:${offset}`, bookingId, runAt, maxAttempts: 5 });
  }
}

/**
 * Agent reminders on every enabled channel, for each host and offset. `keySuffix` is
 * appended to every idempotency key (used by host reassignment).
 */
export async function enqueueAgentReminders(
  db: Db,
  input: { bookingId: string; startMs: number; settings: ReminderSettings; userIds: string[]; now?: number; keySuffix?: string },
): Promise<void> {
  const { bookingId, settings } = input;
  if (!settings.agentChannels.length || !input.userIds.length) return;
  const due = dueOffsets(input.startMs, settings.agentOffsetsMin, input.now ?? Date.now());
  const sfx = input.keySuffix ? `:${input.keySuffix}` : "";
  for (const userId of [...new Set(input.userIds)]) {
    for (const { offset, runAt } of due) {
      if (settings.agentChannels.includes("email")) {
        await enqueueEmail(
          db,
          { template: "host_booking_reminder", bookingId, recipient: { userId }, offsetMin: offset },
          `${bookingId}:host_reminder:${userId}:${offset}${sfx}`,
          runAt,
        );
      }
      if (settings.agentChannels.includes("slack")) {
        const payload: JobPayloads["slack_dm_send"] = { template: "booking_reminder", bookingId, userId, offsetMin: offset };
        await enqueue(db, { kind: "slack_dm_send", payload, idempotencyKey: `${bookingId}:slack_dm:${userId}:${offset}${sfx}`, bookingId, runAt, maxAttempts: 5 });
      }
      if (settings.agentChannels.includes("sms")) {
        const payload: JobPayloads["sms_send"] = { template: "booking_reminder", bookingId, recipient: { userId }, offsetMin: offset };
        await enqueue(db, { kind: "sms_send", payload, idempotencyKey: `${bookingId}:sms:${userId}:${offset}${sfx}`, bookingId, runAt, maxAttempts: 5 });
      }
    }
  }
}

/**
 * Every reminder for a booking: merchant email and SMS at the merchant offsets, and agent
 * reminders on the enabled channels. With the default settings this enqueues exactly the
 * merchant email reminders.
 */
export async function enqueueAllReminders(
  db: Db,
  input: { bookingId: string; startMs: number; hostUserIds: string[]; settings?: ReminderSettings; now?: number },
): Promise<void> {
  const settings = input.settings ?? (await loadReminderSettings(db, input.bookingId));
  const now = input.now ?? Date.now();
  if (settings.merchantChannels.includes("email")) {
    await enqueueReminders(db, input.bookingId, input.startMs, settings.merchantOffsetsMin, now);
  }
  if (settings.merchantChannels.includes("sms")) {
    await enqueueMerchantSms(db, input.bookingId, input.startMs, settings.merchantOffsetsMin, now);
  }
  await enqueueAgentReminders(db, { bookingId: input.bookingId, startMs: input.startMs, settings, userIds: input.hostUserIds, now });
}

/**
 * Marks pending reminder jobs for a booking as dead, on every channel (used on cancel,
 * reschedule and host reassignment). With `userId`, only that host's reminders.
 */
export async function cancelPendingReminders(db: Db, bookingId: string, opts: { userId?: string } = {}): Promise<number> {
  const userFilter = opts.userId
    ? db`and (payload ->> 'userId' = ${opts.userId} or payload -> 'recipient' ->> 'userId' = ${opts.userId})`
    : db``;
  const rows = await db`
    update app.jobs set status = 'dead', last_error = 'booking cancelled', locked_until = null
    where booking_id = ${bookingId}
      and status in ('pending', 'failed')
      and (
        (kind = 'email_send' and payload ->> 'template' in ('booking_reminder', 'host_booking_reminder'))
        or (kind in ('sms_send', 'slack_dm_send') and payload ->> 'template' = 'booking_reminder')
      )
      ${userFilter}
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
    hostUserIds: string[];
    resolved: Pick<ResolvedEventType, "sfSettings">;
    /** Defaults to the booking's event type settings. */
    reminders?: ReminderSettings;
    now?: number;
  },
): Promise<void> {
  const { bookingId } = input;
  await enqueueGraphUpsert(db, bookingId);
  await enqueueEmail(db, { template: "booking_confirmed", bookingId, recipient: "invitee" }, `${bookingId}:confirmed`);
  await enqueueAllReminders(db, {
    bookingId,
    startMs: input.startMs,
    hostUserIds: input.hostUserIds,
    settings: input.reminders,
    now: input.now,
  });
  await enqueueHostNotices(db, bookingId, input.hostUserIds, "created");
  await enqueueSfLeadIfEnabled(db, bookingId, input.resolved);
}

/**
 * Jobs for a reschedule: old events removed, new booking created. Salesforce: in lead modes
 * other than 'create', one sf_lead_create job for the new booking (see
 * enqueueSfLeadOnReschedule); in 'create' mode no Salesforce call, as before.
 */
export async function enqueueBookingRescheduled(
  db: Db,
  input: {
    oldBookingId: string;
    newBookingId: string;
    oldHosts: { userId: string; graphEventId: string | null }[];
    newStartMs: number;
    hostUserIds: string[];
    /** Effective settings of the event type. Without them no Salesforce job is enqueued. */
    resolved?: Pick<ResolvedEventType, "sfSettings">;
    /** Defaults to the new booking's event type settings. */
    reminders?: ReminderSettings;
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
  await enqueueAllReminders(db, {
    bookingId: input.newBookingId,
    startMs: input.newStartMs,
    hostUserIds: input.hostUserIds,
    settings: input.reminders,
    now: input.now,
  });
  await enqueueHostNotices(db, input.newBookingId, input.hostUserIds, "rescheduled");
  await enqueueSfLeadOnReschedule(db, {
    oldBookingId: input.oldBookingId,
    newBookingId: input.newBookingId,
    settings: input.resolved?.sfSettings,
  });
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

