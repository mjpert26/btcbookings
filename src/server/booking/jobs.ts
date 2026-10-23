import "server-only";
import { randomUUID } from "node:crypto";
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
import {
  cancelPendingReminders,
  enqueueAgentReminders,
  enqueueGraphDelete,
  enqueueGraphUpsert,
  enqueueHostNotices,
  loadReminderSettings,
} from "@/server/booking/side-effects";
import { enqueue } from "@/server/jobs/queue";
import { bookingById, bookingHosts } from "@/server/booking/view";
import { hostNames, writeBookingAudit } from "@/server/booking/audit";

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
 *
 * The job does nothing when the member is no longer paused on the event type's team (for
 * example, added back to the queue before the job ran).
 *
 * `reassignId` (the booking_reassign job id) is part of every idempotency key the move
 * enqueues, so a booking that moves back and forth between hosts gets fresh Outlook, email
 * and reminder jobs on every move. The keys are listed in side-effects.ts.
 *
 * Salesforce is not updated: the Lead keeps its owner (docs/n8n-workflows.md).
 */
export async function reassignBooking(
  payload: z.infer<typeof reassignPayload>,
  opts: { sql?: Sql; now?: number; reassignId?: string } = {},
): Promise<JobResult> {
  const sql = opts.sql ?? service();
  const now = opts.now ?? Date.now();
  const reassignId = opts.reassignId ?? randomUUID();
  const booking = await bookingById(sql, payload.bookingId);
  if (!booking) return { result: { skipped: "booking_not_found" } };
  if (booking.status !== "confirmed" || booking.start_at.getTime() <= now) {
    return { result: { skipped: `status_${booking.status}_or_past` } };
  }
  // Bookings imported from Calendly never produce outbound work (Calendly still owns them).
  const [origin] = await sql<{ import_source: string | null }[]>`select import_source from app.bookings where id = ${booking.id}`;
  if (origin?.import_source) return { result: { skipped: "imported_booking" } };
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
    // The member may have been reinstated (queue add, push or admin unpause) after the job
    // was queued. A member with no row on the team is still moved.
    if (et.team_id) {
      const [member] = await tx<{ status: string }[]>`
        select status::text as status from app.team_members where team_id = ${et.team_id} and user_id = ${from.user_id}
      `;
      if (member && member.status !== "paused") return { result: { skipped: "host_active" } };
    }

    const flag = async (why: string) => {
      const flaggedReason = `Reassignment needed: ${why} (${payload.reason})`.slice(0, 500);
      await tx`
        update app.bookings set status = 'flagged', flagged_reason = ${flaggedReason}
        where id = ${booking.id}
      `;
      await writeBookingAudit(tx, {
        action: "booking.flag",
        bookingId: booking.id,
        actorUserId: null,
        via: "system",
        before: { status: locked.status },
        after: { status: "flagged", flaggedReason, source: "reassign", fromUserId: from.user_id },
      });
      return { result: { flagged: why } };
    };
    const beforeHosts = await hostNames(tx, hosts.map((h) => h.user_id));

    if (et.scheduling_mode === "individual") return flag("individual event type");

    if (et.scheduling_mode === "collective") {
      const remaining = hosts.filter((h) => h.user_id !== from.user_id);
      if (!remaining.length) return flag("no remaining host");
      await tx`update app.booking_hosts set active = false, reassigned_at = now() where booking_id = ${booking.id} and user_id = ${from.user_id}`;
      if (from.role === "primary") {
        await tx`update app.booking_hosts set role = 'primary' where booking_id = ${booking.id} and user_id = ${remaining[0].user_id}`;
      }
      await enqueueGraphDelete(tx, booking.id, { userId: from.user_id, graphEventId: from.graph_event_id }, reassignId);
      await enqueueGraphUpsert(tx, booking.id, `reassign:${from.user_id}:${reassignId}`);
      await cancelPendingReminders(tx, booking.id, { userId: from.user_id });
      await writeBookingAudit(tx, {
        action: "booking.reassign",
        bookingId: booking.id,
        actorUserId: null,
        via: "system",
        before: { hosts: beforeHosts },
        after: { hosts: await hostNames(tx, remaining.map((h) => h.user_id)), removedUserId: from.user_id, reason: payload.reason },
      });
      return { result: { removed: from.user_id } };
    }

    // Round-robin. Deactivate first so the old hold does not count for anyone. reassigned_at
    // is set only once a replacement host is in place: setting it fires the booking.reassigned
    // webhook trigger, which must not run for a reassignment that ends flagged.
    await tx`update app.booking_hosts set active = false where booking_id = ${booking.id} and user_id = ${from.user_id}`;
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
      await tx`update app.booking_hosts set reassigned_at = now() where booking_id = ${booking.id} and user_id = ${from.user_id}`;
      await recordRoundRobin(tx, to.teamMemberId);
      await enqueueGraphDelete(tx, booking.id, { userId: from.user_id, graphEventId: from.graph_event_id }, reassignId);
      await enqueueGraphUpsert(tx, booking.id, `reassign:${to.userId}:${reassignId}`);
      await enqueue(tx, {
        kind: "email_send",
        payload: { template: "booking_rescheduled", bookingId: booking.id, recipient: "invitee" },
        idempotencyKey: `${booking.id}:rescheduled:reassign:${to.userId}:${reassignId}`,
        bookingId: booking.id,
      });
      await enqueueHostNotices(tx, booking.id, [to.userId], `reassigned:${reassignId}`);
      await cancelPendingReminders(tx, booking.id, { userId: from.user_id });
      await enqueueAgentReminders(tx, {
        bookingId: booking.id,
        startMs,
        settings: await loadReminderSettings(tx, booking.id),
        userIds: [to.userId],
        now,
        keySuffix: reassignId,
      });
      const afterHosts = await hostNames(tx, [to.userId, ...hosts.filter((h) => h.user_id !== from.user_id).map((h) => h.user_id)]);
      await writeBookingAudit(tx, {
        action: "booking.reassign",
        bookingId: booking.id,
        actorUserId: null,
        via: "system",
        before: { hosts: beforeHosts, hostUserId: from.user_id },
        after: { hosts: afterHosts, hostUserId: to.userId, reason: payload.reason },
      });
      return { result: { reassignedTo: to.userId } };
    }
    // Nobody free: restore the original host and flag for a human. reassigned_at was never
    // set, so the booking stays visible to that host (app.can_read_booking) and no
    // booking.reassigned webhook is sent.
    await tx`update app.booking_hosts set active = true where booking_id = ${booking.id} and user_id = ${from.user_id}`;
    return flag("no eligible host is free");
  }) as Promise<JobResult>;
}

/** Job handlers owned by the booking module. Keys are job kinds. */
export const bookingHandlers: Record<string, JobHandler> = {
  booking_reassign: async (job) => {
    const parsed = reassignPayload.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("Invalid booking_reassign payload");
    return reassignBooking(parsed.data, { reassignId: job.id });
  },
};
