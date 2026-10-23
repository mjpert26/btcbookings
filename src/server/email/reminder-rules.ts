/**
 * Pure rules and types shared by every reminder channel (email, SMS, Slack). No I/O, so
 * templates and unit tests can import this file directly.
 */

/** Reminders that would arrive this early (start moved later) are skipped. */
export const REMINDER_EARLY_TOLERANCE_MS = 10 * 60_000;

/** A reminder may run this late (at least) before it is dropped as stale. */
export const REMINDER_LATE_TOLERANCE_MS = 10 * 60_000;

/**
 * How late a reminder may run before it is stale: the larger of 10 minutes and half its
 * offset (12 hours for a 1 day reminder, 30 minutes for a 1 hour reminder). A stale
 * reminder is dropped so a backlog or a long retry does not deliver several reminders at
 * once, or a "1 day" reminder minutes before the meeting.
 */
export function reminderStaleAfterMs(offsetMin: number): number {
  return Math.max(REMINDER_LATE_TOLERANCE_MS, (offsetMin * 60_000) / 2);
}

/**
 * Returns a skip reason, or null to send. Merchant reminders require a confirmed booking
 * (unchanged from the original email reminders). Agent reminders also go out for flagged
 * bookings, because the meeting still stands for the merchant.
 */
export function reminderSkipReason(
  audience: "merchant" | "agent",
  b: { status: string; start_at: Date },
  offsetMin: number | undefined,
  now: number,
): string | null {
  const allowed = audience === "merchant" ? b.status === "confirmed" : b.status === "confirmed" || b.status === "flagged";
  if (!allowed) return `status_${b.status}`;
  const start = b.start_at.getTime();
  if (now >= start) return "started";
  if (!offsetMin) return "no_offset";
  const due = start - offsetMin * 60_000;
  if (now < due - REMINDER_EARLY_TOLERANCE_MS) return "start_moved";
  if (now > due + reminderStaleAfterMs(offsetMin)) return "stale";
  return null;
}

/** The reminder columns of a booking's event type (see ReminderSettings in side-effects.ts). */
export type ReminderChannelSettings = {
  merchantOffsetsMin: number[];
  merchantChannels: readonly string[];
  agentChannels: readonly string[];
  agentOffsetsMin: number[];
};

/**
 * Re-checks a queued reminder against the event type's current settings, so turning a
 * channel or a reminder time off also stops reminders already queued for existing
 * bookings. Returns a skip reason, or null when the reminder is still enabled.
 */
export function reminderDisabledReason(
  settings: ReminderChannelSettings,
  audience: "merchant" | "agent",
  channel: "email" | "sms" | "slack",
  offsetMin: number | undefined,
): string | null {
  const channels = audience === "merchant" ? settings.merchantChannels : settings.agentChannels;
  if (!channels.includes(channel)) return "channel_disabled";
  const offsets = audience === "merchant" ? settings.merchantOffsetsMin : settings.agentOffsetsMin;
  if (offsetMin === undefined || !offsets.includes(offsetMin)) return "offset_disabled";
  return null;
}

export type AgentReminderData = {
  hostName: string;
  hostEmail: string;
  timezone: string;
  eventName: string;
  partnerName: string | null;
  start: Date;
  end: Date;
  inviteeName: string;
  inviteeEmail: string;
  inviteePhone: string | null;
  answers: { label: string; value: string }[];
  /** Teams join link, phone number or address, whichever applies. */
  meeting: { text: string; url: string | null };
  bookingUrl: string;
  offsetMin: number;
  /**
   * Minutes from the send time to the start, used for the "starts in" text. Equals
   * offsetMin when the reminder runs on time; less when it runs late.
   */
  leadMin: number;
};

/**
 * Lead time to show in a reminder: the configured offset when the reminder runs within
 * the early or late tolerance of its due time, otherwise the actual time left.
 */
export function effectiveLeadMin(start: Date, offsetMin: number, now: number): number {
  const remaining = Math.max(1, Math.round((start.getTime() - now) / 60_000));
  return Math.abs(remaining - offsetMin) * 60_000 <= REMINDER_LATE_TOLERANCE_MS ? offsetMin : remaining;
}

/**
 * "15 minutes", "1 hour", "1 day": the lead time in an agent reminder. Exact multiples of a
 * day or hour use that unit; other values under 90 minutes are shown in minutes, under
 * 2 days in rounded hours, and above that in rounded days.
 */
export function leadTimeLabel(offsetMin: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (offsetMin > 0 && offsetMin % 1440 === 0) return unit(offsetMin / 1440, "day");
  if (offsetMin > 0 && offsetMin % 60 === 0) return unit(offsetMin / 60, "hour");
  if (offsetMin < 90) return unit(offsetMin, "minute");
  if (offsetMin < 2880) return unit(Math.round(offsetMin / 60), "hour");
  return unit(Math.round(offsetMin / 1440), "day");
}
