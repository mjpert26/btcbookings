import { z } from "zod";
import type { Interval, WeeklyRules, Weekday } from "@/server/scheduling/types";

export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const DEFAULT_WEEKLY: WeeklyRules = {
  mon: [{ start: "09:30", end: "18:30" }],
  tue: [{ start: "09:30", end: "18:30" }],
  wed: [{ start: "09:30", end: "18:30" }],
  thu: [{ start: "09:30", end: "18:30" }],
  fri: [{ start: "09:30", end: "18:30" }],
  sat: [],
  sun: [],
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const intervalSchema = z.object({
  start: z.string().regex(TIME_RE, "Use HH:MM (24-hour)."),
  end: z.string().regex(TIME_RE, "Use HH:MM (24-hour)."),
});

/** Minutes after midnight for "HH:MM". */
export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Validates a list of same-day intervals: each start before its end, and no overlaps.
 * Returns an error message, or null when valid. Touching intervals (10:00-11:00, 11:00-12:00) are allowed.
 */
export function intervalListError(list: Interval[]): string | null {
  for (const i of list) {
    if (toMinutes(i.start) >= toMinutes(i.end)) return `Start time must be before end time (${i.start}–${i.end}).`;
  }
  const sorted = [...list].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let k = 1; k < sorted.length; k++) {
    if (toMinutes(sorted[k].start) < toMinutes(sorted[k - 1].end)) {
      return `Intervals overlap (${sorted[k - 1].start}–${sorted[k - 1].end} and ${sorted[k].start}–${sorted[k].end}).`;
    }
  }
  return null;
}

export const intervalListSchema = z
  .array(intervalSchema)
  .max(12, "At most 12 intervals per day.")
  .superRefine((list, ctx) => {
    const err = intervalListError(list);
    if (err) ctx.addIssue({ code: "custom", message: err });
  })
  .transform((list) => [...list].sort((a, b) => toMinutes(a.start) - toMinutes(b.start)));

export const weeklyRulesSchema = z.object({
  mon: intervalListSchema,
  tue: intervalListSchema,
  wed: intervalListSchema,
  thu: intervalListSchema,
  fri: intervalListSchema,
  sat: intervalListSchema,
  sun: intervalListSchema,
});

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().min(1, "Choose a time zone.").refine(isValidTimeZone, "Unknown time zone.");

export const SHOW_AS_VALUES = ["busy", "tentative", "oof", "workingElsewhere", "free"] as const;
export const SHOW_AS_LABELS: Record<(typeof SHOW_AS_VALUES)[number], string> = {
  busy: "Busy",
  tentative: "Tentative",
  oof: "Out of office",
  workingElsewhere: "Working elsewhere",
  free: "Free",
};

/** Normalizes a stored weekly_rules value, filling missing days with no availability. */
export function normalizeWeekly(value: unknown): WeeklyRules {
  const parsed = weeklyRulesSchema.partial().safeParse(value);
  const base = parsed.success ? parsed.data : {};
  const out = {} as WeeklyRules;
  for (const d of WEEKDAYS) out[d] = base[d] ?? [];
  return out;
}
