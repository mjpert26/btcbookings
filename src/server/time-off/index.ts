import "server-only";
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import type { Range } from "@/server/scheduling";
import { parseTimeOff, TIME_OFF_MAX_FUTURE, type TimeOffInput } from "@/lib/time-off";

/**
 * Time off (app.time_off). The create, delete and list functions take a transaction opened
 * with withUser(), so row-level security decides whose blocks the caller can see and change;
 * callers still check roles before offering a screen. loadTimeOffRanges() is for the public
 * booking engine on the service connection and selects only user_id, starts_at and ends_at.
 */

export type TimeOffBlock = {
  id: string;
  userId: string;
  userName: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timezone: string;
  note: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
};

/** A confirmed upcoming booking that overlaps a time-off block. Time and invitee name only. */
export type OverlappingBooking = { bookingId: string; startAt: Date; endAt: Date; inviteeName: string };

type BlockRow = {
  id: string;
  user_id: string;
  user_name: string;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  timezone: string;
  note: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
};

function toBlock(r: BlockRow): TimeOffBlock {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: r.all_day,
    timezone: r.timezone,
    note: r.note,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}

/**
 * The zone a user's time off is entered in: the zone of their default availability schedule,
 * else their profile zone. Null when the user does not exist or is inactive.
 */
export async function timeOffZone(db: Db, userId: string): Promise<string | null> {
  const [row] = await db<{ timezone: string }[]>`
    select coalesce(
      (select s.timezone from app.availability_schedules s where s.owner_user_id = u.id and s.is_default limit 1),
      u.timezone
    ) as timezone
    from app.users u
    where u.id = ${userId} and u.is_active
  `;
  return row?.timezone ?? null;
}

/**
 * Blocks that have not ended, soonest first. Pass userId to limit the list to one person.
 * Row-level security limits agents to their own blocks.
 */
export async function listTimeOff(tx: Tx, opts: { userId?: string | null; now?: Date; limit?: number } = {}): Promise<TimeOffBlock[]> {
  const now = opts.now ?? new Date();
  const rows = await tx<BlockRow[]>`
    select t.id, t.user_id, u.name as user_name, t.starts_at, t.ends_at, t.all_day, t.timezone, t.note,
           t.created_by, c.name as created_by_name, t.created_at
    from app.time_off t
    join app.users u on u.id = t.user_id
    left join app.users c on c.id = t.created_by
    where t.ends_at > ${now}
      ${opts.userId ? tx`and t.user_id = ${opts.userId}` : tx``}
    order by t.starts_at, t.ends_at, t.id
    limit ${opts.limit ?? 500}
  `;
  return rows.map(toBlock);
}

/**
 * Confirmed bookings hosted by `userId` that have not ended and overlap [startsAt, endsAt).
 * Returns the time and invitee name only. Under row-level security an agent sees only their
 * own bookings; admins see everyone's.
 */
export async function overlappingBookings(
  tx: Tx,
  userId: string,
  range: { startsAt: Date; endsAt: Date },
  now: Date = new Date(),
  limit = 200,
): Promise<OverlappingBooking[]> {
  const rows = await tx<{ id: string; start_at: Date; end_at: Date; invitee_name: string }[]>`
    select distinct b.id, b.start_at, b.end_at, b.invitee_name
    from app.bookings b
    join app.booking_hosts bh on bh.booking_id = b.id and bh.active and bh.user_id = ${userId}
    where b.status = 'confirmed'
      and b.end_at > ${now}
      and b.start_at < ${range.endsAt}
      and b.end_at > ${range.startsAt}
    order by b.start_at, b.id
    limit ${limit}
  `;
  return rows.map((r) => ({ bookingId: r.id, startAt: r.start_at, endAt: r.end_at, inviteeName: r.invitee_name }));
}

/**
 * For one person's blocks, the confirmed upcoming bookings inside each block, keyed by
 * block id. Blocks with no bookings inside are left out. The limit applies per block, so
 * bookings that fall between blocks never crowd out bookings inside a later block.
 */
export async function bookingsInsideBlocks(
  tx: Tx,
  userId: string,
  blocks: { id: string; startsAt: Date; endsAt: Date }[],
  now: Date = new Date(),
  perBlockLimit = 200,
): Promise<Record<string, OverlappingBooking[]>> {
  const out: Record<string, OverlappingBooking[]> = {};
  if (!blocks.length) return out;
  const ids = blocks.map((b) => b.id);
  const starts = blocks.map((b) => b.startsAt.toISOString());
  const ends = blocks.map((b) => b.endsAt.toISOString());
  const rows = await tx<{ block_id: string; id: string; start_at: Date; end_at: Date; invitee_name: string }[]>`
    select block_id, id, start_at, end_at, invitee_name
    from (
      select blk.id as block_id, b.id, b.start_at, b.end_at, b.invitee_name,
             row_number() over (partition by blk.id order by b.start_at, b.id) as rn
      from unnest(${ids}::uuid[], ${starts}::timestamptz[], ${ends}::timestamptz[]) as blk(id, s, e)
      join app.bookings b on b.start_at < blk.e and b.end_at > blk.s
      where b.status = 'confirmed'
        and b.end_at > ${now}
        and exists (
          select 1 from app.booking_hosts bh
          where bh.booking_id = b.id and bh.active and bh.user_id = ${userId}
        )
    ) x
    where rn <= ${perBlockLimit}
    order by block_id, start_at, id
  `;
  for (const r of rows) {
    (out[r.block_id] ??= []).push({ bookingId: r.id, startAt: r.start_at, endAt: r.end_at, inviteeName: r.invitee_name });
  }
  return out;
}

export type CreateTimeOffResult =
  | { ok: true; block: TimeOffBlock; overlapping: OverlappingBooking[] }
  | { ok: false; message: string; errors?: Record<string, string> };

/**
 * Adds a time-off block for `userId` and audits it in the same transaction. The input is
 * read in the user's zone (timeOffZone). Refused when the user is inactive or already has
 * TIME_OFF_MAX_FUTURE blocks that have not ended. Existing bookings are not changed; the
 * result lists the confirmed upcoming bookings that overlap the new block.
 */
export async function createTimeOff(
  tx: Tx,
  p: { actorUserId: string; userId: string; input: TimeOffInput; now?: Date; ipHash?: string | null },
): Promise<CreateTimeOffResult> {
  const now = p.now ?? new Date();
  const zone = await timeOffZone(tx, p.userId);
  if (!zone) return { ok: false, message: "That person was not found or is no longer active." };
  const parsed = parseTimeOff(p.input, { zone, now: now.getTime() });
  if (!parsed.ok) return { ok: false, message: parsed.errors._form ?? "Please fix the highlighted fields.", errors: parsed.errors };
  const v = parsed.value;

  // Serializes adds for one person so the limit below cannot be passed by concurrent saves.
  await tx`select pg_advisory_xact_lock(hashtext(${`time_off:${p.userId}`}))`;
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from app.time_off where user_id = ${p.userId} and ends_at > ${now}
  `;
  if (n >= TIME_OFF_MAX_FUTURE) {
    return {
      ok: false,
      message: `There are already ${TIME_OFF_MAX_FUTURE} upcoming time-off blocks. Delete one before adding another.`,
    };
  }

  // No RETURNING, consistent with other inserts made under row-level security.
  const id = randomUUID();
  await tx`
    insert into app.time_off (id, user_id, starts_at, ends_at, all_day, timezone, note, created_by)
    values (${id}, ${p.userId}, ${v.startsAt}, ${v.endsAt}, ${v.allDay}, ${v.timezone}, ${v.note}, ${p.actorUserId})
  `;
  // The note is personal and is never written to the audit log.
  await writeAudit(tx, {
    actorUserId: p.actorUserId,
    action: "time_off.create",
    entityType: "time_off",
    entityId: id,
    after: { user_id: p.userId, starts_at: v.startsAt.toISOString(), ends_at: v.endsAt.toISOString(), all_day: v.allDay },
    ipHash: p.ipHash ?? null,
  });
  const [row] = await tx<BlockRow[]>`
    select t.id, t.user_id, u.name as user_name, t.starts_at, t.ends_at, t.all_day, t.timezone, t.note,
           t.created_by, c.name as created_by_name, t.created_at
    from app.time_off t
    join app.users u on u.id = t.user_id
    left join app.users c on c.id = t.created_by
    where t.id = ${id}
  `;
  const overlapping = await overlappingBookings(tx, p.userId, v, now);
  return { ok: true, block: toBlock(row), overlapping };
}

/**
 * Deletes a block and audits it in the same transaction. With `userId`, only that person's
 * block is deleted (the self-service page passes the signed-in user). Returns false when no
 * visible, deletable block matched.
 */
export async function deleteTimeOff(
  tx: Tx,
  p: { actorUserId: string; id: string; userId?: string | null; ipHash?: string | null },
): Promise<boolean> {
  const rows = await tx<{ user_id: string; starts_at: Date; ends_at: Date; all_day: boolean }[]>`
    delete from app.time_off
    where id = ${p.id}
      ${p.userId ? tx`and user_id = ${p.userId}` : tx``}
    returning user_id, starts_at, ends_at, all_day
  `;
  const row = rows[0];
  if (!row) return false;
  await writeAudit(tx, {
    actorUserId: p.actorUserId,
    action: "time_off.delete",
    entityType: "time_off",
    entityId: p.id,
    before: { user_id: row.user_id, starts_at: row.starts_at.toISOString(), ends_at: row.ends_at.toISOString(), all_day: row.all_day },
    ipHash: p.ipHash ?? null,
  });
  return true;
}

/**
 * Time-off ranges per user that overlap [from, to), for the slot engine. Runs on the
 * service connection; selects only user_id, starts_at and ends_at.
 */
export async function loadTimeOffRanges(db: Db, userIds: string[], from: Date, to: Date): Promise<Map<string, Range[]>> {
  const out = new Map<string, Range[]>();
  if (!userIds.length) return out;
  const rows = await db<{ user_id: string; starts_at: Date; ends_at: Date }[]>`
    select user_id, starts_at, ends_at from app.time_off
    where user_id = any(${userIds}::uuid[]) and starts_at < ${to} and ends_at > ${from}
  `;
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push({ start: r.starts_at.getTime(), end: r.ends_at.getTime() });
    out.set(r.user_id, list);
  }
  return out;
}
