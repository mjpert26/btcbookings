import "server-only";
import type { Db } from "@/server/db/client";
import { assignHost, generateSlots, type HostAvailabilityInput, type Slot } from "@/server/scheduling";
import {
  loadAvailability,
  loadPool,
  slotSettings,
  type AvailabilityContext,
  type LoadedEventType,
  type PoolHost,
} from "@/server/booking/load";
import type { LiveBusyBlock, LiveBusyProvider } from "@/server/booking/types";

/**
 * Transaction building blocks shared by booking create, invitee reschedule and host
 * reassignment. Everything here runs inside one transaction (PLAN 4.3).
 */

const MINUTE = 60_000;

/** Postgres SQLSTATE for an exclusion constraint violation (booking_hosts_no_overlap). */
export const EXCLUSION_VIOLATION = "23P01";
export const UNIQUE_VIOLATION = "23505";

export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/** Serializes assignment decisions for one team (or one individual host). */
export async function lockAssignment(db: Db, loaded: LoadedEventType): Promise<void> {
  const et = loaded.resolved.eventType;
  const key = `assign:${et.team_id ?? et.owner_user_id}`;
  await db`select pg_advisory_xact_lock(hashtext(${key}))`;
}

export type ConfirmedSlot = { ctx: AvailabilityContext; slot: Slot };

/**
 * Re-runs the engine for exactly one start time and returns the slot with its free hosts,
 * or null when it is not available. `relaxed` ignores minimum notice, the booking window
 * and the slot grid; host reassignment uses it for an existing booking's time.
 */
export async function confirmSlot(
  db: Db,
  loaded: LoadedEventType,
  opts: {
    startMs: number;
    durationMin: number;
    now: number;
    liveBusy?: Record<string, LiveBusyBlock[]> | null;
    excludeBookingId?: string | null;
    lockMembers?: boolean;
    relaxed?: boolean;
    pool?: PoolHost[];
  },
): Promise<ConfirmedSlot | null> {
  const et = loaded.resolved.eventType;
  const endMs = opts.startMs + opts.durationMin * MINUTE;
  const pool = opts.pool ?? (await loadPool(db, loaded, { lockMembers: opts.lockMembers }));
  const ctx = await loadAvailability(db, loaded, pool, { from: opts.startMs, to: endMs }, {
    liveBusy: opts.liveBusy,
    excludeBookingId: opts.excludeBookingId,
  });
  const settings = slotSettings(et, opts.durationMin, ctx.schedule);
  if (opts.relaxed) {
    settings.minNoticeMin = 0;
    settings.bookingWindowDays = Math.max(
      settings.bookingWindowDays,
      Math.ceil((opts.startMs - opts.now) / 86_400_000) + 1,
    );
    // A one-minute grid always contains the start time when it lies inside an interval.
    settings.slotIntervalMin = 1;
  }
  const slots = generateSlots({
    mode: et.scheduling_mode,
    settings,
    hosts: ctx.hosts,
    now: opts.now,
    from: opts.startMs,
    to: opts.startMs + 1,
    eventBookingsPerDay: ctx.eventBookingsPerDay,
  });
  const slot = slots.find((s) => s.start === opts.startMs);
  return slot ? { ctx, slot } : null;
}

/** Live busy lookup with a timeout. Failures fall back to the cache (returns null). */
export async function fetchLiveBusy(
  provider: LiveBusyProvider | undefined,
  userIds: string[],
  from: Date,
  to: Date,
  timeoutMs = 2000,
): Promise<Record<string, LiveBusyBlock[]> | null> {
  if (!provider || userIds.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider(userIds, from, to),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ChosenHost = HostAvailabilityInput & { role: "primary" | "collective" };

/**
 * Chooses the host(s) for a confirmed slot.
 * - individual: the owner.
 * - round_robin: assignHost with the event's strategy over free hosts; preferredUserIds
 *   are tried in order (sticky returning invitee, original host on reschedule).
 * - collective: every required host; the first in pool order is primary.
 */
export function chooseHosts(
  loaded: LoadedEventType,
  confirmed: ConfirmedSlot,
  opts: { preferredUserIds?: string[]; exclude?: Set<string> } = {},
): ChosenHost[] | null {
  const et = loaded.resolved.eventType;
  const free = new Set(confirmed.slot.freeHostIds);
  const exclude = opts.exclude ?? new Set<string>();
  const candidates = confirmed.ctx.hosts.filter((h) => free.has(h.userId) && !exclude.has(h.userId));
  if (et.scheduling_mode === "individual") {
    const owner = candidates[0];
    return owner ? [{ ...owner, role: "primary" }] : null;
  }
  if (et.scheduling_mode === "collective") {
    const required = confirmed.ctx.hosts.filter((h) => h.isRequired);
    if (!required.length || required.some((h) => !free.has(h.userId) || exclude.has(h.userId))) return null;
    return required.map((h, i) => ({ ...h, role: i === 0 ? "primary" : "collective" }));
  }
  for (const preferred of opts.preferredUserIds ?? []) {
    const picked = assignHost({ strategy: et.rr_strategy, candidates, preferredUserId: preferred });
    if (picked && picked.userId === preferred) return [{ ...picked, role: "primary" }];
  }
  const picked = assignHost({ strategy: et.rr_strategy, candidates });
  return picked ? [{ ...picked, role: "primary" }] : null;
}

/** Blocked range including the event type's buffers. */
export function blockedRange(loaded: LoadedEventType, startMs: number, endMs: number): { from: Date; to: Date } {
  const et = loaded.resolved.eventType;
  return {
    from: new Date(startMs - et.buffer_before_min * MINUTE),
    to: new Date(endMs + et.buffer_after_min * MINUTE),
  };
}

export async function insertBookingHosts(
  db: Db,
  bookingId: string,
  hosts: ChosenHost[],
  range: { from: Date; to: Date },
): Promise<void> {
  for (const h of hosts) {
    await db`
      insert into app.booking_hosts (booking_id, user_id, team_member_id, role, blocked_range, active)
      values (${bookingId}, ${h.userId}, ${h.teamMemberId ?? null}, ${h.role},
              tstzrange(${range.from}, ${range.to}, '[)'), true)
    `;
  }
}

/** Round-robin bookkeeping for the assigned host. */
export async function recordRoundRobin(db: Db, teamMemberId: string | undefined): Promise<void> {
  if (!teamMemberId) return;
  await db`
    update app.team_members
    set rr_assignment_count = rr_assignment_count + 1, rr_last_assigned_at = now()
    where id = ${teamMemberId}
  `;
}

/**
 * Hosts of the invitee's earlier bookings on this team, most recent first, for the
 * sticky returning-invitee rule. Cancelled bookings do not count.
 */
export async function priorHostsForInvitee(db: Db, teamId: string, email: string): Promise<string[]> {
  const rows = await db<{ user_id: string }[]>`
    select bh.user_id
    from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    join app.booking_hosts bh on bh.booking_id = b.id and bh.role = 'primary'
    where et.team_id = ${teamId} and b.invitee_email = ${email} and b.status <> 'cancelled'
    order by b.created_at desc
    limit 20
  `;
  return [...new Set(rows.map((r) => r.user_id))];
}
