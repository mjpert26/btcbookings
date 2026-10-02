import { DateTime } from "luxon";

/** Formats an instant in the given IANA zone, e.g. "Tue, Oct 6, 2026, 10:30 AM EDT". */
export function formatDateTime(at: Date | string, zone: string): string {
  return DateTime.fromJSDate(new Date(at), { zone }).toFormat("ccc, LLL d, yyyy, h:mm a ZZZZ");
}

export function formatDate(at: Date | string, zone: string): string {
  return DateTime.fromJSDate(new Date(at), { zone }).toFormat("ccc, LLL d, yyyy");
}

export function formatTime(at: Date | string, zone: string): string {
  return DateTime.fromJSDate(new Date(at), { zone }).toFormat("h:mm a");
}

/** "Tue, Oct 6 · 10:30 – 11:00 AM EDT" */
export function formatRange(start: Date | string, end: Date | string, zone: string): string {
  const s = DateTime.fromJSDate(new Date(start), { zone });
  const e = DateTime.fromJSDate(new Date(end), { zone });
  return `${s.toFormat("ccc, LLL d")} · ${s.toFormat("h:mm a")} – ${e.toFormat("h:mm a ZZZZ")}`;
}

export function formatRelative(at: Date | string | null | undefined): string {
  if (!at) return "Never";
  return DateTime.fromJSDate(new Date(at)).toRelative() ?? "";
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  if (min % 60 === 0) return `${min / 60} hr`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}

export const LOCATION_LABELS: Record<string, string> = {
  teams: "Microsoft Teams",
  phone: "Phone call",
  in_person: "In person",
  custom: "Custom",
};
