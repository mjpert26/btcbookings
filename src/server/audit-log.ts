import "server-only";
import { DateTime } from "luxon";
import { z } from "zod";
import { withUser, type Tx } from "@/server/db/client";
import { AUDIT_VIAS } from "@/server/audit";
import { can, type Role } from "@/lib/permissions";
import { actorLabel, fieldChanges, type FieldChange } from "@/lib/audit-diff";

/**
 * Read side of the audit log: the admin audit viewer (/admin/audit, BTCSCHED-48) and booking
 * history timelines (BTCSCHED-47). Both read as the signed-in user under row-level security:
 * managers and admins read every entry (audit_log_select), and everyone reads the entries of
 * bookings they can read (audit_log_booking_select).
 */

export type BookingHistoryEntry = {
  id: string;
  at: string;
  action: string;
  /** The acting user's name; null for invitees and the system. */
  actor: string | null;
  /** The user's name, "Invitee" or "System". */
  actorLabel: string;
  via: string | null;
  changes: FieldChange[];
  /** Set on a reschedule shown on the new booking: the booking it replaced. */
  rescheduledFromId: string | null;
};

type HistoryRow = {
  id: string;
  created_at: Date;
  action: string;
  via: string | null;
  actor_name: string | null;
  entity_id: string;
  before: unknown;
  after: unknown;
};

/**
 * A booking's history, oldest first: its own booking.* entries plus the reschedule entry of
 * the booking it replaced. Returns nothing for a booking the user cannot read.
 */
export async function loadBookingHistory(tx: Tx, bookingId: string, limit = 200): Promise<BookingHistoryEntry[]> {
  if (!z.uuid().safeParse(bookingId).success) return [];
  const rows = await tx<HistoryRow[]>`
    select a.id, a.created_at, a.action, a.via, u.name as actor_name, a.entity_id, a.before, a.after
    from app.audit_log a
    left join app.users u on u.id = a.actor_user_id
    where a.entity_type = 'booking'
      and (a.entity_id = ${bookingId} or (a.action = 'booking.reschedule' and a.after ->> 'newBookingId' = ${bookingId}))
    order by a.created_at, a.id
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at.toISOString(),
    action: r.action,
    actor: r.actor_name,
    actorLabel: actorLabel(r.actor_name, r.via),
    via: r.via,
    changes: fieldChanges(r.before, r.after),
    rescheduledFromId: r.entity_id !== bookingId ? r.entity_id : null,
  }));
}

// ---------------------------------------------------------------------------
// Admin audit viewer
// ---------------------------------------------------------------------------

export class AuditForbiddenError extends Error {
  constructor() {
    super("The audit log is limited to admins and managers.");
    this.name = "AuditForbiddenError";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);

/** Query-string filters. Invalid values are dropped rather than rejected. */
export const auditFiltersSchema = z.object({
  actor: opt(z.uuid()),
  entityType: opt(z.string().max(60).regex(/^[a-z0-9_]+$/)),
  entityId: opt(z.string().trim().min(1).max(200)),
  /** Matches actions starting with this text, e.g. "booking." or "event_type.update". */
  action: opt(z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-z0-9_.]+$/)),
  via: opt(z.enum(AUDIT_VIAS as [string, ...string[]])),
  from: opt(z.string().regex(DATE)),
  to: opt(z.string().regex(DATE)),
  /** Keyset cursor from the previous page ("<epoch microseconds>.<entry id>"). */
  cursor: opt(z.string().regex(/^\d{1,17}\.[0-9a-f-]{36}$/)),
});
export type AuditFilters = z.infer<typeof auditFiltersSchema>;

export type AuditEntryView = {
  id: string;
  at: Date;
  actorUserId: string | null;
  actor: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string | null;
  via: string | null;
  changes: FieldChange[];
};

export type AuditPage = {
  entries: AuditEntryView[];
  /** Cursor for the next (older) page, or null on the last page. */
  nextCursor: string | null;
  options: { actions: string[]; entityTypes: string[]; actors: { id: string; name: string }[] };
};

function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * One page of the audit log, newest first, for a user whose role grants audit.read (admins and
 * managers). Dates are whole days in `timezone`.
 */
export async function loadAuditPage(
  user: { id: string; role: Role },
  raw: Record<string, unknown>,
  opts: { timezone?: string; pageSize?: number } = {},
): Promise<AuditPage & { filters: AuditFilters }> {
  if (!can(user.role, "audit.read")) throw new AuditForbiddenError();
  const f = auditFiltersSchema.parse(raw);
  const zone = opts.timezone ?? "UTC";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const fromAt = f.from ? DateTime.fromISO(f.from, { zone }).startOf("day") : null;
  const toAt = f.to ? DateTime.fromISO(f.to, { zone }).plus({ days: 1 }).startOf("day") : null;
  const dot = f.cursor ? f.cursor.indexOf(".") : -1;
  const cursorUs = f.cursor && dot > 0 ? f.cursor.slice(0, dot) : null;
  const cursorId = f.cursor && dot > 0 ? f.cursor.slice(dot + 1) : null;

  return withUser(user.id, async (tx) => {
    const rows = await tx<
      {
        id: string;
        created_at: Date;
        at_us: string;
        actor_user_id: string | null;
        actor_name: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        via: string | null;
        before: unknown;
        after: unknown;
      }[]
    >`
      select a.id, a.created_at, (extract(epoch from a.created_at) * 1000000)::bigint::text as at_us,
             a.actor_user_id, u.name as actor_name, a.action, a.entity_type, a.entity_id, a.via, a.before, a.after
      from app.audit_log a
      left join app.users u on u.id = a.actor_user_id
      where true
        ${f.actor ? tx`and a.actor_user_id = ${f.actor}` : tx``}
        ${f.entityType ? tx`and a.entity_type = ${f.entityType}` : tx``}
        ${f.entityId ? tx`and a.entity_id = ${f.entityId}` : tx``}
        ${f.action ? tx`and a.action like ${likePrefix(f.action)}` : tx``}
        ${f.via ? tx`and a.via = ${f.via}` : tx``}
        ${fromAt?.isValid ? tx`and a.created_at >= ${fromAt.toJSDate()}` : tx``}
        ${toAt?.isValid ? tx`and a.created_at < ${toAt.toJSDate()}` : tx``}
        ${
          cursorUs && cursorId
            ? tx`and (a.created_at, a.id) < (timestamptz 'epoch' + ${cursorUs}::bigint * interval '1 microsecond', ${cursorId}::uuid)`
            : tx``
        }
      order by a.created_at desc, a.id desc
      limit ${pageSize + 1}
    `;
    const actions = await tx<{ action: string }[]>`select distinct action from app.audit_log order by action`;
    const entityTypes = await tx<{ entity_type: string }[]>`select distinct entity_type from app.audit_log order by entity_type`;
    const actors = await tx<{ id: string; name: string }[]>`
      select u.id, u.name from app.users u
      where exists (select 1 from app.audit_log a where a.actor_user_id = u.id)
      order by u.name
    `;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      filters: f,
      entries: page.map((r) => ({
        id: r.id,
        at: r.created_at,
        actorUserId: r.actor_user_id,
        actor: r.actor_name,
        actorLabel: actorLabel(r.actor_name, r.via),
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        via: r.via,
        changes: fieldChanges(r.before, r.after),
      })),
      nextCursor: rows.length > pageSize && last ? `${last.at_us}.${last.id}` : null,
      options: { actions: actions.map((a) => a.action), entityTypes: entityTypes.map((e) => e.entity_type), actors },
    };
  });
}
