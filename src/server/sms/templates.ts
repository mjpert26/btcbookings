import { DateTime } from "luxon";
import { LOCALE_TAGS, isLocale, type Locale } from "@/i18n/locales";
import { brand } from "@/theme/brand";
import { translator } from "@/server/email/i18n";
import type { AgentReminderData } from "@/server/email/reminder-rules";

/**
 * SMS bodies. Pure, so they are unit-tested directly. Kept short: one or two SMS segments
 * in the common case. Merchant texts are localized and always end with the opt-out line.
 */

export type MerchantSmsData = {
  locale: Locale;
  eventName: string;
  partnerName: string | null;
  start: Date;
  timezone: string;
  /** Teams join link when the meeting is online. */
  joinUrl: string | null;
  manageUrl: string | null;
};

function shortWhen(start: Date, zone: string, locale: string): { date: string; time: string; zone: string } {
  const tag = LOCALE_TAGS[isLocale(locale) ? locale : "en"];
  const s = DateTime.fromJSDate(start, { zone }).setLocale(tag);
  return {
    date: s.toLocaleString({ weekday: "short", month: "short", day: "numeric" }),
    time: s.toLocaleString({ hour: "numeric", minute: "2-digit" }),
    zone: s.offsetNameShort ?? zone,
  };
}

export function merchantReminderSms(d: MerchantSmsData): string {
  const t = translator(d.locale, "sms");
  const when = shortWhen(d.start, d.timezone, d.locale);
  return [
    t("reminder", { brand: brand.name, event: d.eventName, date: when.date, time: when.time, zone: when.zone }),
    d.partnerName ? t("partner", { partner: d.partnerName }) : null,
    d.joinUrl ? t("join", { url: d.joinUrl }) : null,
    d.manageUrl ? t("manage", { url: d.manageUrl }) : null,
    t("optOut"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Agent (host) reminder text. English, like the rest of the internal notifications. */
export function agentReminderSms(d: AgentReminderData): string {
  const when = shortWhen(d.start, d.timezone, "en");
  return [
    `Reminder: ${d.eventName} with ${d.inviteeName}${d.partnerName ? ` (${d.partnerName})` : ""} on ${when.date} at ${when.time} ${when.zone}.`,
    d.inviteePhone ? `Phone: ${d.inviteePhone}.` : null,
    d.meeting.url
      ? `Join: ${d.meeting.url}`
      : d.meeting.text && !(d.inviteePhone && d.meeting.text.includes(d.inviteePhone))
        ? `${d.meeting.text}.`
        : null,
    `Details: ${d.bookingUrl}`,
  ]
    .filter(Boolean)
    .join(" ");
}
