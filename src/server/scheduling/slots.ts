/**
 * Slot generation (PLAN 4.1). Pure: no I/O, no clock reads. All instants are epoch
 * milliseconds in UTC; wall-clock math happens in the schedule's IANA zone with Luxon.
 *
 * Rules implemented here:
 * - Weekly rules and date overrides are expanded per local date in the schedule's zone.
 *   A date override replaces the weekly rules for that date (empty = closed).
 * - Candidate slots step by slotIntervalMin in absolute time from each interval start, so
 *   a 09:30-18:30 rule always covers nine real hours, including on DST transition days.
 * - Local times that do not exist (spring-forward gap) resolve to the transition instant,
 *   so a rule touching the gap never yields slots inside it. Ambiguous local times
 *   (fall-back overlap) resolve to the earlier offset. Results are deduplicated by start.
 * - Blocked range = [start - bufferBefore, end + bufferAfter). A host is free when the
 *   blocked range intersects no busy block whose showAs is in host.unavailableShowAs and
 *   no existing booked range (which already includes that booking's buffers).
 * - All-day events follow the same showAs rule; the stored range is authoritative.
 *   All-day events whose showAs is not in the unavailable set (e.g. "free") never block.
 * - Host schedule: when host.schedule is non-null, the host is available only where BOTH
 *   the event type schedule and the host's own schedule are open (intersection). The slot
 *   itself must fit inside the host's schedule; buffers may extend outside working hours.
 * - Slots starting before now + minNotice, or after the end of the local day (schedule
 *   zone) that is bookingWindowDays after now, are dropped.
 * - Daily caps (host.dailyCap) and the event cap (settings.maxPerDay) are counted per host
 *   per local date in the host's zone, keyed by the slot's start.
 */
import { DateTime } from "luxon";
import type {
  GenerateSlotsInput,
  HostAvailabilityInput,
  Interval,
  Range,
  Schedule,
  Slot,
  Weekday,
} from "./types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Slot interval default from PLAN section 12: equal to the duration, minimum 15 minutes. */
export function defaultSlotInterval(durationMin: number, slotIntervalMin: number | null): number {
  return slotIntervalMin ?? Math.max(15, durationMin);
}

function parseWallTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid wall time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) {
    throw new Error(`Invalid wall time: ${value}`);
  }
  return { hour, minute };
}

function offsetAt(ms: number, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).offset;
}

/**
 * Resolves a local wall time on a date to a UTC instant. Times inside a DST gap resolve
 * to the transition instant (the first valid instant after the gap). "24:00" is the start
 * of the next day.
 */
export function localToInstant(date: string, time: string, zone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const { hour, minute } = parseWallTime(time);
  if (hour === 24) {
    const next = DateTime.fromObject({ year, month, day }, { zone }).plus({ days: 1 });
    return localToInstant(next.toISODate()!, "00:00", zone);
  }
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone });
  if (!dt.isValid) throw new Error(`Invalid local time ${date} ${time} in ${zone}`);
  if (dt.day === day && dt.hour === hour && dt.minute === minute) return dt.toMillis();

  // Nonexistent local time. Luxon shifted it forward; find the transition instant by
  // binary search on the offset (transitions are at most a few hours apart from here).
  const target = dt.offset;
  let lo = dt.toMillis() - 6 * 60 * MINUTE;
  let hi = dt.toMillis();
  if (offsetAt(lo, zone) === target) return dt.toMillis();
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, zone) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function weekdayOf(date: string, zone: string): Weekday {
  const dt = DateTime.fromISO(date, { zone });
  return WEEKDAYS[dt.weekday - 1];
}

function intervalsForDate(schedule: Schedule, date: string, overrides: Map<string, Interval[]>) {
  return overrides.get(date) ?? schedule.weekly[weekdayOf(date, schedule.timezone)] ?? [];
}

function overrideMap(schedule: Schedule): Map<string, Interval[]> {
  const map = new Map<string, Interval[]>();
  for (const o of schedule.overrides) {
    // Several overrides for one date are combined.
    map.set(o.date, [...(map.get(o.date) ?? []), ...o.intervals]);
  }
  return map;
}

/**
 * Expands a schedule into UTC ranges, in local-date order, for every local date that can
 * overlap [from, to). Ranges are not merged, so callers can step from each interval start.
 */
export function expandSchedule(schedule: Schedule, from: number, to: number): Range[] {
  const zone = schedule.timezone;
  const overrides = overrideMap(schedule);
  const out: Range[] = [];
  let cursor = DateTime.fromMillis(from - DAY, { zone }).startOf("day");
  const last = DateTime.fromMillis(to + DAY, { zone }).toISODate()!;
  for (let guard = 0; guard < 1000; guard++) {
    const date = cursor.toISODate()!;
    if (date > last) break;
    for (const interval of intervalsForDate(schedule, date, overrides)) {
      const start = localToInstant(date, interval.start, zone);
      const end = localToInstant(date, interval.end, zone);
      if (end > start && end > from && start < to) out.push({ start, end });
    }
    cursor = cursor.plus({ days: 1 }).startOf("day");
  }
  return out;
}

/** Sorts and merges overlapping or adjacent ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** Index of the first merged range whose end is after `point`. */
function firstEndingAfter(merged: Range[], point: number): number {
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid].end > point) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** True when the half-open range [start, end) overlaps any merged range. */
function intersectsAny(merged: Range[], start: number, end: number): boolean {
  const i = firstEndingAfter(merged, start);
  return i < merged.length && merged[i].start < end;
}

/** True when [start, end) lies entirely inside one merged range. */
function containedIn(merged: Range[], start: number, end: number): boolean {
  const i = firstEndingAfter(merged, start);
  return i < merged.length && merged[i].start <= start && merged[i].end >= end;
}

type PreparedHost = {
  host: HostAvailabilityInput;
  blocking: Range[];
  ownSchedule: Range[] | null;
  dayKeys: Map<number, string>;
};

function prepareHost(host: HostAvailabilityInput, from: number, to: number): PreparedHost {
  const unavailable = new Set(host.unavailableShowAs);
  const busy = host.busy
    .filter((b) => unavailable.has(b.showAs))
    .map((b) => ({ start: b.start, end: b.end }));
  return {
    host,
    blocking: mergeRanges([...busy, ...host.booked]),
    ownSchedule: host.schedule ? mergeRanges(expandSchedule(host.schedule, from, to)) : null,
    dayKeys: new Map(),
  };
}

function hostLocalDate(p: PreparedHost, start: number): string {
  let key = p.dayKeys.get(start);
  if (key === undefined) {
    key = DateTime.fromMillis(start, { zone: p.host.timezone }).toISODate()!;
    p.dayKeys.set(start, key);
  }
  return key;
}

function isHostFree(
  p: PreparedHost,
  slot: Range,
  blocked: Range,
  maxPerDay: number | null,
  eventBookingsPerDay: Record<string, Record<string, number>> | undefined,
): boolean {
  const { host } = p;
  if (!host.eligible) return false;
  if (p.ownSchedule && !containedIn(p.ownSchedule, slot.start, slot.end)) return false;
  if (intersectsAny(p.blocking, blocked.start, blocked.end)) return false;
  if (host.dailyCap !== null || maxPerDay !== null) {
    const day = hostLocalDate(p, slot.start);
    if (host.dailyCap !== null && (host.bookingsPerDay[day] ?? 0) >= host.dailyCap) return false;
    if (maxPerDay !== null && (eventBookingsPerDay?.[host.userId]?.[day] ?? 0) >= maxPerDay) {
      return false;
    }
  }
  return true;
}

export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { settings, now, mode } = input;
  const zone = settings.schedule.timezone;
  const durationMs = settings.durationMin * MINUTE;
  const stepMs = settings.slotIntervalMin * MINUTE;
  if (durationMs <= 0 || stepMs <= 0) throw new Error("duration and slot interval must be positive");

  const earliest = Math.max(now + settings.minNoticeMin * MINUTE, input.from ?? -Infinity);
  const windowEnd = DateTime.fromMillis(now, { zone })
    .plus({ days: settings.bookingWindowDays })
    .endOf("day")
    .toMillis();
  const latestStart = Math.min(windowEnd, (input.to ?? Infinity) - 1);
  if (latestStart < earliest) return [];

  // Hosts whose availability determines the slot, per mode.
  let considered: HostAvailabilityInput[];
  if (mode === "individual") considered = input.hosts.slice(0, 1);
  else if (mode === "collective") considered = input.hosts.filter((h) => h.isRequired);
  else considered = input.hosts.filter((h) => h.eligible);
  if (considered.length === 0) return [];
  if (mode === "collective" && considered.some((h) => !h.eligible)) return [];

  const rangeFrom = earliest;
  const rangeTo = latestStart + durationMs;
  const prepared = considered.map((h) => prepareHost(h, rangeFrom, rangeTo));
  const bufferBefore = settings.bufferBeforeMin * MINUTE;
  const bufferAfter = settings.bufferAfterMin * MINUTE;

  const byStart = new Map<number, Slot>();
  for (const interval of expandSchedule(settings.schedule, rangeFrom, rangeTo)) {
    for (let start = interval.start; start + durationMs <= interval.end; start += stepMs) {
      if (start < earliest) continue;
      if (start > latestStart) break;
      if (byStart.has(start)) continue;
      const slot = { start, end: start + durationMs };
      const blocked = { start: start - bufferBefore, end: slot.end + bufferAfter };
      const free = prepared
        .filter((p) =>
          isHostFree(p, slot, blocked, settings.maxPerDay, input.eventBookingsPerDay),
        )
        .map((p) => p.host.userId);
      const ok = mode === "round_robin" ? free.length > 0 : free.length === prepared.length;
      if (ok) byStart.set(start, { ...slot, freeHostIds: free });
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}
