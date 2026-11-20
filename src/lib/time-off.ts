import { DateTime } from "luxon";
import { localToInstant } from "@/server/scheduling/slots";
import { isValidTimeZone } from "@/lib/availability";

/**
 * Time off: a date range or a time window during which a user is unavailable on every
 * booking page they host. Pure helpers shared by the server actions, the pages and tests.
 * All wall-clock math happens in the user's IANA zone with Luxon; results are UTC instants.
 */

export const TIME_OFF_NOTE_MAX = 200;
/** Longest block, matching the table's check constraint (interval '366 days'). */
export const TIME_OFF_MAX_DAYS = 366;
/** Most blocks a user may have that have not ended yet. */
export const TIME_OFF_MAX_FUTURE = 100;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Raw form values. Dates are "YYYY-MM-DD" and times "HH:MM" in the user's zone. */
export type TimeOffInput = {
  allDay: boolean;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  note?: string | null;
};

export type TimeOffValue = {
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timezone: string;
  note: string | null;
};

export type TimeOffParseResult =
  | { ok: true; value: TimeOffValue }
  | { ok: false; errors: Record<string, string> };

function isDate(v: string): boolean {
  return DATE_RE.test(v) && DateTime.fromISO(v, { zone: "UTC" }).isValid;
}

/**
 * Converts validated form values to a UTC range. An all-day block runs from 00:00 on the
 * start date to 24:00 on the end date in `zone`, so it covers whole local days even on
 * 23- and 25-hour days. A time window runs from start date and time to end date and time
 * (end date defaults to the start date). Local times inside a DST gap resolve to the
 * transition instant; ambiguous times resolve to the earlier offset.
 */
export function timeOffRange(input: TimeOffInput, zone: string): { startsAt: number; endsAt: number } {
  const endDate = input.endDate || input.startDate;
  if (input.allDay) {
    return {
      startsAt: localToInstant(input.startDate, "00:00", zone),
      endsAt: localToInstant(endDate, "24:00", zone),
    };
  }
  return {
    startsAt: localToInstant(input.startDate, input.startTime ?? "", zone),
    endsAt: localToInstant(endDate, input.endTime ?? "", zone),
  };
}

/**
 * Validates form values and converts them to a UTC range. Errors are keyed by form field
 * name. Rejects an end before the start, a block that has already ended, a block longer
 * than 366 days and a note longer than 200 characters.
 */
export function parseTimeOff(input: TimeOffInput, opts: { zone: string; now: number }): TimeOffParseResult {
  const errors: Record<string, string> = {};
  if (!isValidTimeZone(opts.zone)) errors._form = "The time zone for this person is not valid.";
  const startDate = (input.startDate ?? "").trim();
  const endDate = (input.endDate ?? "").trim() || startDate;
  if (!isDate(startDate)) errors.startDate = "Choose a start date.";
  if (!isDate(endDate)) errors.endDate = "Choose an end date.";
  const startTime = (input.startTime ?? "").trim();
  const endTime = (input.endTime ?? "").trim();
  if (!input.allDay) {
    if (!TIME_RE.test(startTime)) errors.startTime = "Choose a start time.";
    if (!TIME_RE.test(endTime)) errors.endTime = "Choose an end time.";
  }
  const note = (input.note ?? "").trim();
  if (note.length > TIME_OFF_NOTE_MAX) errors.note = `Keep the note to ${TIME_OFF_NOTE_MAX} characters or fewer.`;
  if (Object.keys(errors).length) return { ok: false, errors };

  if (input.allDay && endDate < startDate) {
    return { ok: false, errors: { endDate: "The end date must be on or after the start date." } };
  }
  const { startsAt, endsAt } = timeOffRange({ allDay: input.allDay, startDate, endDate, startTime, endTime }, opts.zone);
  if (!(endsAt > startsAt)) {
    return { ok: false, errors: { [input.allDay ? "endDate" : "endTime"]: "The end must be after the start." } };
  }
  if (endsAt - startsAt > TIME_OFF_MAX_DAYS * DAY_MS) {
    return { ok: false, errors: { endDate: `Time off can last at most ${TIME_OFF_MAX_DAYS} days.` } };
  }
  if (endsAt <= opts.now) {
    return { ok: false, errors: { [input.allDay ? "endDate" : "endTime"]: "This time off has already ended." } };
  }
  return {
    ok: true,
    value: { startsAt: new Date(startsAt), endsAt: new Date(endsAt), allDay: input.allDay, timezone: opts.zone, note: note || null },
  };
}

/**
 * Human-readable range in the block's zone, for example "Mon, Dec 7, 2026 (all day)",
 * "Mon, Dec 7 – Fri, Dec 11, 2026 (all day)" or "Mon, Dec 7, 2026, 1:00 PM – 3:00 PM EST".
 */
export function formatTimeOff(block: { startsAt: Date; endsAt: Date; allDay: boolean; timezone: string }): string {
  const s = DateTime.fromJSDate(block.startsAt, { zone: block.timezone });
  const e = DateTime.fromJSDate(block.endsAt, { zone: block.timezone });
  if (block.allDay) {
    // The stored end is 00:00 on the day after the last day off.
    const last = DateTime.fromMillis(block.endsAt.getTime() - 1, { zone: block.timezone });
    if (last.toISODate() === s.toISODate()) return `${s.toFormat("ccc, LLL d, yyyy")} (all day)`;
    const sameYear = last.year === s.year;
    return `${s.toFormat(sameYear ? "ccc, LLL d" : "ccc, LLL d, yyyy")} – ${last.toFormat("ccc, LLL d, yyyy")} (all day)`;
  }
  if (s.toISODate() === e.toISODate()) {
    return `${s.toFormat("ccc, LLL d, yyyy, h:mm a")} – ${e.toFormat("h:mm a ZZZZ")}`;
  }
  return `${s.toFormat("ccc, LLL d, yyyy, h:mm a")} – ${e.toFormat("ccc, LLL d, yyyy, h:mm a ZZZZ")}`;
}
