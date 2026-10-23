import "server-only";
import type { Db } from "@/server/db/client";
import { writeAudit, type AuditVia } from "@/server/audit";

/**
 * Booking lifecycle audit entries (BTCSCHED-47). Every create, reschedule, cancel, reassign
 * and flag writes exactly one booking.* entry in the same transaction as the change:
 *
 * - invitees on the public pages: actor null, via 'public';
 * - signed-in users (web, REST, MCP): their user id, via from the request context;
 * - background jobs and webhooks: actor null, via 'system'.
 *
 * Entries hold times, statuses, host names and ids, and reasons. They never hold manage
 * tokens, invitee contact details or answers. Bookings copied by the Calendly import get no
 * per-booking entries; the import run writes import.calendly.* entries instead.
 */
export type BookingAuditAction = "booking.create" | "booking.reschedule" | "booking.cancel" | "booking.reassign" | "booking.flag";

export async function writeBookingAudit(
  db: Db,
  e: {
    action: BookingAuditAction;
    bookingId: string;
    actorUserId: string | null;
    /** Defaults to 'public' without an actor, otherwise to the request context's channel. */
    via?: AuditVia;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  await writeAudit(db, {
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: "booking",
    entityId: e.bookingId,
    before: e.before ?? undefined,
    after: e.after ?? undefined,
    via: e.via ?? (e.actorUserId ? undefined : "public"),
  });
}

/** Display names for host user ids, in the order given. */
export async function hostNames(db: Db, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const rows = await db<{ id: string; name: string }[]>`select id, name from app.users where id = any(${userIds}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return userIds.map((id) => byId.get(id) ?? "Unknown user");
}
