import "server-only";
import { z } from "zod";
import { service, type Sql } from "@/server/db/client";
import { PermanentJobError, type JobHandler, type JobResult } from "@/server/jobs/types";
import { loadEventTypeById } from "@/server/booking/load";
import {
  blockedRange,
  chooseHosts,
  confirmSlot,
  EXCLUSION_VIOLATION,
  insertBookingHosts,
  lockAssignment,
  pgCode,
  recordRoundRobin,
} from "@/server/booking/engine";
import { enqueueGraphDelete, enqueueGraphUpsert, enqueueHostNotices } from "@/server/booking/side-effects";
import { enqueue } from "@/server/jobs/queue";
import { bookingById, bookingHosts } from "@/server/booking/view";

const reassignPayload = z.object({
  bookingId: z.uuid(),
  fromUserId: z.uuid(),
  reason: z.string().max(500),
});

const MAX_CANDIDATE_TRIES = 5;

/**
 * booking_reassign: moves a future booking away from a host (queue member paused with
 * removal_policy = reassign). The time does not change.
 *
 * - Round-robin: another eligible, free member is chosen with the event's strategy. The
 *   availability check ignores minimum notice and the slot grid (the time is already
 *   booked) but respects schedules, busy time, caps and buffers.
 * - Collective: the host is removed; if they were primary, the next host becomes primary.
 *   If no host would remain, the booking is flagged.
 * - Individual, or nobody free: the booking keeps its host and is set to 'flagged' with
 *   flagged_reason so an admin can act.
 *
 * The invitee is told about a host change with the booking_rescheduled template (the
 * template set in jobs/kinds.ts is shared and has no "host changed" value); that email
 * shows the unchanged time and the new host.
 */
export async function reassignBooking(
  payload: z.infer<typeof reassignPayload>,
  opts: { sql?: Sql; now?: number } = {},
): Promise<JobResult> {
  const sql = opts.sql ?? service();
  const now = opts.now ?? Date.now();
  const booking = await bookingById(sql, payload.bookingId);
  if (!booking) return { result: { skipped: "booking_not_found" } };
  if (booking.status !== "confirmed" || booking.start_at.getTime() <= now) {
    return { result: { skipped: `status_${booking.status}_or_past` } };
  }
  const loaded = await loadEventTypeById(sql, booking.event_type_id);
  if (!loaded) throw new PermanentJobError("Event type not found");
  const et = loaded.resolved.eventType;
  const startMs = booking.start_at.getTime();
  const endMs = booking.end_at.getTime();
  const durationMin = Math.round((endMs - startMs) / 60_000);

  return sql.begin(async (tx) => {
    await lockAssignment(tx, loaded);
    const locked = await bookingById(tx, booking.id, { forUpdate: true });
    if (!locked || locked.status !== "confirmed") return { result: { skipped: "status_changed" } };
    const hosts = await bookingHosts(tx, booking.id, true);
    const from = hosts.find((h) => h.user_id === payload.fromUserId);
    if (!from) return { result: { skipped: "host_not_assigned" } };

    const flag = async (why: string) => {
      await tx`
        update app.bookings set status = 'flagged', flagged_reason = ${`Reassignment needed: ${why} (${payload.reason})`.slice(0, 500)}
        where id = ${booking.id}
      `;
      return { result: { flagged: why } };
    };

    if (et.scheduling_mode === "individual") return flag("individual event type");

    if (et.scheduling_mode === "collective") {
      const remaining = hosts.filter((h) => h.user_id !== from.user_id);
      if (!remaining.length) return flag("no remaining host");
      await tx`update app.booking_hosts set active = false, reassigned_at = now() where booking_id = ${booking.id} and user_id = ${from.user_id}`;
      if (from.role === "primary") {
        await tx`update app.booking_hosts set role = 'primary' where booking_id = ${booking.id} and user_id = ${remaining[0].user_id}`;
      }
      await enqueueGraphDelete(tx, booking.id, { userId: from.user_id, graphEventId: from.graph_event_id });
      await enqueueGraphUpsert(tx, booking.id, `reassign:${from.user_id}`);
      return { result: { removed: from.user_id } };
    }

    // Round-robin. Deactivate first so the old hold does not count for anyone.
    await tx`update app.booking_hosts set active = false, reassigned_at = now() where booking_id = ${booking.id} and user_id = ${from.user_id}`;
    const confirmed = await confirmSlot(tx, loaded, {
      startMs,
      durationMin,
      now,
      lockMembers: true,
      relaxed: true,
    });
    const exclude = new Set<string>([from.user_id]);
    const range = blockedRange(loaded, startMs, endMs);
    for (let i = 0; confirmed && i < MAX_CANDIDATE_TRIES; i++) {
      const chosen = chooseHosts(loaded, confirmed, { exclude });
      if (!chosen) break;
      try {
        await tx.savepoint(async (sp) => {
          await sp`delete from app.booking_hosts where booking_id = ${booking.id} and user_id = ${chosen[0].userId} and not active`;
          await insertBookingHosts(sp, booking.id, chosen, range);
        });
      } catch (err) {
        if (pgCode(err) === EXCLUSION_VIOLATION) {
          exclude.add(chosen[0].userId);
          continue;
        }
        throw err;
      }
      const to = chosen[0];
      await recordRoundRobin(tx, to.teamMemberId);
      await enqueueGraphDelete(tx, booking.id, { userId: from.user_id, graphEventId: from.graph_event_id });
      await enqueueGraphUpsert(tx, booking.id, `reassign:${to.userId}`);
      await enqueue(tx, {
        kind: "email_send",
        payload: { template: "booking_rescheduled", bookingId: booking.id, recipient: "invitee" },
        idempotencyKey: `${booking.id}:rescheduled:reassign:${to.userId}`,
        bookingId: booking.id,
      });
      await enqueueHostNotices(tx, booking.id, [to.userId], `reassigned`);
      return { result: { reassignedTo: to.userId } };
    }
    // Nobody free: restore the original host and flag for a human.
    await tx`update app.booking_hosts set active = true where booking_id = ${booking.id} and user_id = ${from.user_id}`;
    return flag("no eligible host is free");
  }) as Promise<JobResult>;
}

/** Job handlers owned by the booking module. Keys are job kinds. */
export const bookingHandlers: Record<string, JobHandler> = {
  booking_reassign: async (job) => {
    const parsed = reassignPayload.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("Invalid booking_reassign payload");
    return reassignBooking(parsed.data);
  },
};
