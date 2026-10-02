import { DateTime } from "luxon";
import type {
  HostAvailabilityInput,
  Interval,
  Schedule,
  SlotSettings,
  Weekday,
} from "@/server/scheduling/types";

export const NY = "America/New_York";
export const LA = "America/Los_Angeles";

/** Epoch ms for a local ISO wall time in a zone, e.g. t("2026-10-05T09:30"). */
export function t(local: string, zone = NY): number {
  const dt = DateTime.fromISO(local, { zone });
  if (!dt.isValid) throw new Error(`bad time ${local}`);
  return dt.toMillis();
}

/** Local "YYYY-MM-DDTHH:mm" for an instant in a zone. */
export function local(ms: number, zone = NY): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}

const EMPTY_WEEK: Record<Weekday, Interval[]> = {
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
};

export function schedule(
  zone: string,
  days: Partial<Record<Weekday, Interval[]>>,
  overrides: Schedule["overrides"] = [],
): Schedule {
  return { timezone: zone, weekly: { ...EMPTY_WEEK, ...days }, overrides };
}

const WORKDAY = [{ start: "09:30", end: "18:30" }];

/** Default template: 9:30 to 18:30, Monday to Friday. */
export function weekdays(zone = NY, overrides: Schedule["overrides"] = []): Schedule {
  return schedule(
    zone,
    { mon: WORKDAY, tue: WORKDAY, wed: WORKDAY, thu: WORKDAY, fri: WORKDAY },
    overrides,
  );
}

export function host(userId: string, patch: Partial<HostAvailabilityInput> = {}): HostAvailabilityInput {
  return {
    userId,
    unavailableShowAs: ["busy", "tentative", "oof"],
    busy: [],
    booked: [],
    bookingsPerDay: {},
    dailyCap: null,
    timezone: NY,
    schedule: null,
    weight: 1,
    priorityTier: 1,
    rrAssignmentCount: 0,
    rrLastAssignedAt: null,
    isRequired: true,
    eligible: true,
    ...patch,
  };
}

export function settings(patch: Partial<SlotSettings> = {}): SlotSettings {
  return {
    durationMin: 30,
    slotIntervalMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    bookingWindowDays: 30,
    maxPerDay: null,
    schedule: weekdays(),
    ...patch,
  };
}
