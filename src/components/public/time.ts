/**
 * Browser-side date helpers for the booking UI. Uses Intl only (no Luxon in the client
 * bundle). Calendar dates are "YYYY-MM-DD" strings in the invitee's selected zone.
 */
import { LOCALE_TAGS, isLocale } from "@/i18n/locales";

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

export function localeTag(locale: string): string {
  return LOCALE_TAGS[isLocale(locale) ? locale : "en"];
}

/** Calendar date of an instant in a zone. */
export function dateKey(ms: number, zone: string): string {
  let f = keyFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    keyFormatters.set(zone, f);
  }
  return f.format(ms);
}

export function parseKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

export function makeKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Noon UTC of a calendar date: safe for formatting the date itself in any locale. */
function noonUtc(key: string): Date {
  const { y, m, d } = parseKey(key);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function formatLongDate(key: string, locale: string): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(noonUtc(key));
}

export function formatMonth(y: number, m: number, locale: string): string {
  return new Intl.DateTimeFormat(localeTag(locale), { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
}

export function formatTime(ms: number, zone: string, locale: string): string {
  return new Intl.DateTimeFormat(localeTag(locale), { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(ms);
}

export function formatDateTime(ms: number, zone: string, locale: string): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: zone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

/** Short weekday names starting on Sunday. */
export function weekdayNames(locale: string, style: "short" | "long"): string[] {
  const f = new Intl.DateTimeFormat(localeTag(locale), { timeZone: "UTC", weekday: style });
  // 2026-10-04 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2026, 9, 4 + i, 12))));
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Weeks of the month as date keys (null for leading/trailing blanks), Sunday first. */
export function monthGrid(y: number, m: number): (string | null)[][] {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const total = daysInMonth(y, m);
  const cells: (string | null)[] = [...Array(first).fill(null)];
  for (let d = 1; d <= total; d++) cells.push(makeKey(y, m, d));
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addDays(key: string, days: number): string {
  const { y, m, d } = parseKey(key);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return makeKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/** "GMT-04:00" style offset of a zone right now, for the time zone list. */
export function zoneOffsetLabel(zone: string, at = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

export function detectTimezone(fallback = "America/New_York"): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch {
    return fallback;
  }
}

const FALLBACK_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico", "America/Mexico_City", "America/Bogota",
  "America/Lima", "America/Caracas", "America/Santiago", "America/Argentina/Buenos_Aires", "America/Sao_Paulo",
  "America/Guatemala", "America/El_Salvador", "America/Panama", "America/Santo_Domingo", "Europe/London",
  "Europe/Madrid", "UTC",
];

export function allTimezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length) return list.includes("UTC") ? list : [...list, "UTC"];
  } catch {
    // Older browsers.
  }
  return FALLBACK_ZONES;
}
