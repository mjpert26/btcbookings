import { DateTime } from "luxon";
import { LOCALE_TAGS, isLocale } from "@/i18n/locales";

export type FormattedWhen = {
  /** "Tuesday, October 6, 2026" */
  date: string;
  /** "10:00 AM" */
  time: string;
  /** "10:00 AM – 10:30 AM" */
  range: string;
  /** "Eastern Daylight Time" style label for the zone at that instant. */
  zoneName: string;
};

/** Formats a meeting time in the reader's zone and locale. */
export function formatWhen(start: Date, end: Date, zone: string, locale: string): FormattedWhen {
  const tag = LOCALE_TAGS[isLocale(locale) ? locale : "en"];
  const s = DateTime.fromJSDate(start, { zone }).setLocale(tag);
  const e = DateTime.fromJSDate(end, { zone }).setLocale(tag);
  const time = (d: DateTime) => d.toLocaleString({ hour: "numeric", minute: "2-digit" });
  return {
    date: s.toLocaleString({ weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    time: time(s),
    range: `${time(s)} – ${time(e)}`,
    zoneName: s.offsetNameLong ?? zone,
  };
}
