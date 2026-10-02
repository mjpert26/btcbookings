import "server-only";
import { randomUUID } from "node:crypto";
import { service } from "@/server/db/client";
import { sha256Hex } from "@/server/crypto/random";
import { loadEventTypeById, loadPool } from "@/server/booking/load";
import { slotsFor } from "@/server/booking/slots";
import { tokenSchema } from "@/server/booking/validation";
import {
  blockedRange,
  chooseHosts,
  confirmSlot,
  EXCLUSION_VIOLATION,
  fetchLiveBusy,
  insertBookingHosts,
  lockAssignment,
  pgCode,
  recordRoundRobin,
} from "@/server/booking/engine";
import { insertBooking } from "@/server/booking/create";
import {
  enqueueBookingCancelled,
  enqueueBookingRescheduled,
  issueManageToken,
} from "@/server/booking/side-effects";
import { bookingById, bookingHosts, bookingIdByTokenHash, buildPublicView, type BookingRow } from "@/server/booking/view";
import {
  BookingError,
  BookingNotFoundError,
  SlotTakenError,
  type BookingOptions,
  type BookingResult,
  type PublicBookingView,
  type PublicSlot,
} from "@/server/booking/types";

const MINUTE = 60_000;

/**
 * Invitee self-service by manage token (/b/[token]).
 *
 * Reschedule decision: a reschedule creates a NEW booking (rescheduled_from_id = old id)
 * with a NEW manage token. The old link then shows "This booking was rescheduled" without
 * linking to the new one; the new link reaches the invitee only through the reschedule
 * email and the response to the reschedule request itself.
 */

async function resolveToken(token: string): Promise<string | null> {
  if (!tokenSchema.safeParse(token).success) return null;
  return bookingIdByTokenHash(service(), sha256Hex(token));
}

export async function getBookingByToken(token: string, now = Date.now()): Promise<PublicBookingView | null> {
  const id = await resolveToken(token);
  if (!id) return null;
  const booking = await bookingById(service(), id);
  return booking ? buildPublicView(service(), booking, now) : null;
}

/** Internal: booking row by token, for routes that need raw fields (ICS). */
export async function getBookingRowByToken(token: string): Promise<BookingRow | null> {
  const id = await resolveToken(token);
  return id ? bookingById(service(), id) : null;
}

function isLive(b: BookingRow, now: number): boolean {
  return (b.status === "confirmed" || b.status === "flagged") && b.start_at.getTime() > now;
}

export async function cancelByInvitee(token: string, reason: string | undefined, now = Date.now()): Promise<PublicBookingView> {
  const id = await resolveToken(token);
  if (!id) throw new BookingNotFoundError();
  const sql = service();
  await sql.begin(async (tx) => {
    const booking = await bookingById(tx, id, { forUpdate: true });
    if (!booking) throw new BookingNotFoundError();
    if (!isLive(booking, now)) throw new BookingError("not_allowed", "Booking can no longer be cancelled");
    const hosts = await bookingHosts(tx, id, true);
    await tx`
      update app.bookings
      set status = 'cancelled', cancelled_by = 'invitee', cancelled_at = now(),
          cancel_reason = ${reason?.trim() ? reason.trim() : null}
      where id = ${id}
    `;
    await tx`update app.booking_hosts set active = false where booking_id = ${id}`;
    await enqueueBookingCancelled(tx, {
      bookingId: id,
      hosts: hosts.map((h) => ({ userId: h.user_id, graphEventId: h.graph_event_id })),
    });
  });
  const booking = (await bookingById(sql, id))!;
  return buildPublicView(sql, booking, now);
}

/** Slots for rescheduling: the booking's own hold does not block its new time. */
export async function rescheduleSlots(
  token: string,
  range: { from: Date; to: Date },
  now = Date.now(),
): Promise<PublicSlot[]> {
  const id = await resolveToken(token);
  if (!id) throw new BookingNotFoundError();
  const sql = service();
  const booking = await bookingById(sql, id);
  if (!booking || !isLive(booking, now)) throw new BookingError("not_allowed", "Booking cannot be rescheduled");
  const loaded = await loadEventTypeById(sql, booking.event_type_id);
  if (!loaded || !loaded.active) throw new BookingError("not_allowed", "Booking cannot be rescheduled");
  return slotsFor(sql, loaded, {
    from: range.from.getTime(),
    to: range.to.getTime(),
    durationMin: Math.round((booking.end_at.getTime() - booking.start_at.getTime()) / MINUTE),
    now,
    excludeBookingId: id,
  });
}

/**
 * Moves a booking to a new time in one transaction: the old booking becomes
 * 'rescheduled' with inactive hosts, and a new linked booking is confirmed. Round-robin
 * prefers the original host when free. The Salesforce lead is carried over (sf_lead_id
 * and sf_lead_status are copied) and no new sf_lead_create job is enqueued.
 */
export async function rescheduleByInvitee(
  token: string,
  input: { start: string; timezone?: string },
  opts: BookingOptions = {},
): Promise<BookingResult> {
  const now = opts.now ?? Date.now();
  const id = await resolveToken(token);
  if (!id) throw new BookingNotFoundError();
  const sql = service();
  const current = await bookingById(sql, id);
  if (!current || !isLive(current, now)) throw new BookingError("not_allowed", "Booking cannot be rescheduled");
  const loaded = await loadEventTypeById(sql, current.event_type_id);
  if (!loaded || !loaded.active) throw new BookingError("not_allowed", "Booking cannot be rescheduled");
  const et = loaded.resolved.eventType;

  const startMs = Date.parse(input.start);
  const durationMin = Math.round((current.end_at.getTime() - current.start_at.getTime()) / MINUTE);
  const endMs = startMs + durationMin * MINUTE;
  if (!Number.isFinite(startMs) || startMs <= now || startMs % MINUTE !== 0) throw new SlotTakenError();
  if (startMs === current.start_at.getTime()) throw new BookingError("invalid", "Choose a different time");

  const range = blockedRange(loaded, startMs, endMs);
  const prePool = opts.liveBusy ? await loadPool(sql, loaded) : [];
  const liveBusy = await fetchLiveBusy(
    opts.liveBusy,
    prePool.filter((p) => p.eligible).map((p) => p.userId),
    range.from,
    range.to,
    opts.liveBusyTimeoutMs,
  );

  let newId: string;
  let newToken: string;
  try {
    ({ newId, newToken } = await sql.begin(async (tx) => {
      await lockAssignment(tx, loaded);
      const old = await bookingById(tx, id, { forUpdate: true });
      if (!old || !isLive(old, now)) throw new BookingError("not_allowed", "Booking cannot be rescheduled");
      const oldHosts = await bookingHosts(tx, id, true);
      await tx`update app.booking_hosts set active = false where booking_id = ${id}`;

      const confirmed = await confirmSlot(tx, loaded, {
        startMs,
        durationMin,
        now,
        liveBusy,
        lockMembers: true,
        excludeBookingId: id,
      });
      if (!confirmed) throw new SlotTakenError();

      const original = oldHosts.find((h) => h.role === "primary")?.user_id;
      const exclude = new Set<string>();
      for (let attempt = 0; attempt < 2; attempt++) {
        const hosts = chooseHosts(loaded, confirmed, { preferredUserIds: original ? [original] : [], exclude });
        if (!hosts) throw new SlotTakenError();
        const bookingId = randomUUID();
        const issued = issueManageToken(bookingId);
        try {
          await tx.savepoint(async (sp) => {
            await insertBooking(sp, loaded, {
              id: bookingId,
              startMs,
              endMs,
              name: old.invitee_name,
              email: old.invitee_email,
              phone: old.invitee_phone,
              timezone: input.timezone ?? old.invitee_timezone,
              tokenHash: issued.hash,
              tokenEnc: issued.encrypted,
              idempotencyKey: null,
              rescheduledFromId: old.id,
              sfLeadId: old.sf_lead_id,
              sfLeadStatus: old.sf_lead_status,
            });
            await insertBookingHosts(sp, bookingId, hosts, range);
            await sp`
              insert into app.booking_answers (booking_id, question_id, question_key, value)
              select ${bookingId}, question_id, question_key, value from app.booking_answers where booking_id = ${old.id}
            `;
          });
        } catch (err) {
          if (pgCode(err) === EXCLUSION_VIOLATION && et.scheduling_mode === "round_robin" && attempt === 0) {
            exclude.add(hosts[0].userId);
            continue;
          }
          if (pgCode(err) === EXCLUSION_VIOLATION) throw new SlotTakenError();
          throw err;
        }
        await tx`update app.bookings set status = 'rescheduled' where id = ${old.id}`;
        // Round-robin credit goes to a newly assigned host only; keeping the same host is not a new assignment.
        if (et.scheduling_mode === "round_robin" && hosts[0].userId !== original) {
          await recordRoundRobin(tx, hosts[0].teamMemberId);
        }
        await enqueueBookingRescheduled(tx, {
          oldBookingId: old.id,
          newBookingId: bookingId,
          oldHosts: oldHosts.map((h) => ({ userId: h.user_id, graphEventId: h.graph_event_id })),
          newStartMs: startMs,
          reminderOffsetsMin: et.reminder_offsets_min,
          hostUserIds: hosts.map((h) => h.userId),
          now,
        });
        return { newId: bookingId, newToken: issued.token };
      }
      throw new SlotTakenError();
    }));
  } catch (err) {
    if (pgCode(err) === EXCLUSION_VIOLATION) throw new SlotTakenError();
    throw err;
  }
  const booking = (await bookingById(sql, newId))!;
  return { token: newToken, view: await buildPublicView(sql, booking, now), replayed: false };
}
