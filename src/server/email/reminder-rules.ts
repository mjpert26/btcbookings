/**
 * Pure rules and types shared by every reminder channel (email, SMS, Slack). No I/O, so
 * templates and unit tests can import this file directly.
 */

/** Reminders that would arrive this early (start moved later) are skipped. */
export const REMINDER_EARLY_TOLERANCE_MS = 10 * 60_000;

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
};

/** "15 minutes", "1 hour", "1 day": the lead time in an agent reminder. */
export function leadTimeLabel(offsetMin: number): string {
  if (offsetMin % 1440 === 0) {
    const d = offsetMin / 1440;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (offsetMin % 60 === 0) {
    const h = offsetMin / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${offsetMin} minute${offsetMin === 1 ? "" : "s"}`;
}
