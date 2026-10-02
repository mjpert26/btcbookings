import "server-only";
import { service, withUser } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { writeAudit } from "@/server/audit";
import type { JobPayloads } from "@/server/jobs/kinds";

export type HostCancelResult =
  | { ok: true; alreadyCancelled: boolean }
  | { ok: false; reason: "not_found" | "not_cancellable" };

/**
 * Cancels a booking on behalf of a signed-in host, event owner, team admin or admin.
 *
 * Authorization pattern (two steps):
 *   1. Under withUser (RLS), read the booking and update its status columns. app_user
 *      may only update status/cancel columns, and only on bookings it can read, so a
 *      caller without access gets "not_found" and nothing changes.
 *   2. Only after step 1 succeeds, use the service connection to deactivate the
 *      booking_hosts rows (app_user has no update grant there, by design: the exclusion
 *      constraint that prevents double booking must only be changed by trusted code) and
 *      to enqueue the Outlook delete and invitee email jobs (app_user cannot insert jobs).
 *
 * Step 2 is idempotent (active=false, unique job idempotency keys), so if it fails after
 * step 1 committed, calling this function again completes the cancellation.
 */
export async function cancelBookingAsHost(actorUserId: string, bookingId: string, reason: string | null): Promise<HostCancelResult> {
  const step1 = await withUser(actorUserId, async (tx) => {
    const [b] = await tx<{ id: string; status: string; cancelled_by: string | null }[]>`
      select id, status, cancelled_by from app.bookings where id = ${bookingId}
    `;
    if (!b) return { kind: "not_found" as const };
    if (b.status === "cancelled") {
      return { kind: "already" as const, finishable: b.cancelled_by === "host" };
    }
    if (b.status === "rescheduled") return { kind: "not_cancellable" as const };
    await tx`
      update app.bookings
      set status = 'cancelled', cancelled_by = 'host', cancelled_at = now(), cancel_reason = ${reason}
      where id = ${bookingId}
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "booking.cancel",
      entityType: "booking",
      entityId: bookingId,
      before: { status: b.status },
      after: { status: "cancelled", cancelledBy: "host", reason },
    });
    return { kind: "cancelled" as const };
  });

  if (step1.kind === "not_found") return { ok: false, reason: "not_found" };
  if (step1.kind === "not_cancellable") return { ok: false, reason: "not_cancellable" };
  if (step1.kind === "already" && !step1.finishable) return { ok: true, alreadyCancelled: true };

  await service().begin(async (tx) => {
    const hosts = await tx<{ user_id: string; graph_event_id: string | null }[]>`
      update app.booking_hosts set active = false
      where booking_id = ${bookingId}
      returning user_id, graph_event_id
    `;
    for (const h of hosts) {
      const payload: JobPayloads["graph_event_delete"] = { bookingId, userId: h.user_id, graphEventId: h.graph_event_id };
      await enqueue(tx, {
        kind: "graph_event_delete",
        payload,
        idempotencyKey: `cancel:${bookingId}:${h.user_id}`,
        bookingId,
      });
    }
    const email: JobPayloads["email_send"] = { template: "booking_cancelled", bookingId, recipient: "invitee" };
    await enqueue(tx, {
      kind: "email_send",
      payload: email,
      idempotencyKey: `booking_cancelled:${bookingId}:invitee`,
      bookingId,
    });
  });

  return { ok: true, alreadyCancelled: step1.kind === "already" };
}
