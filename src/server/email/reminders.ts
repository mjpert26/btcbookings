import "server-only";
import type { Db } from "@/server/db/client";
import { env } from "@/server/env";
import { pickLocalized } from "@/i18n/locales";
import { bookingHosts, eventInfo, type BookingRow } from "@/server/booking/view";
import { partnerNameForEventType } from "@/server/email/partner";
import { effectiveLeadMin, type AgentReminderData } from "@/server/email/reminder-rules";

export { reminderDisabledReason, reminderSkipReason, leadTimeLabel, type AgentReminderData } from "@/server/email/reminder-rules";

function meetingFor(b: BookingRow): { text: string; url: string | null } {
  switch (b.location_type) {
    case "teams":
      return b.online_meeting_url
        ? { text: "Join Microsoft Teams meeting", url: b.online_meeting_url }
        : { text: "Microsoft Teams (link in the Outlook invitation)", url: null };
    case "phone":
      return { text: b.invitee_phone ? `Call ${b.invitee_phone}` : b.location_detail ? `Phone: ${b.location_detail}` : "Phone call", url: null };
    case "in_person":
    case "custom":
      return { text: b.location_detail ?? "See booking details", url: null };
  }
}

/**
 * Reminder data for one agent, loaded from fresh booking state. Returns null when the
 * user is no longer an active host of the booking (reassigned or removed). `now` sets the
 * lead time shown when the reminder runs late.
 */
export async function loadAgentReminderData(
  db: Db,
  b: BookingRow,
  userId: string,
  offsetMin: number,
  now: number = Date.now(),
): Promise<AgentReminderData | null> {
  const hosts = await bookingHosts(db, b.id, true);
  const host = hosts.find((h) => h.user_id === userId);
  if (!host) return null;
  const [info, partnerName, answers] = await Promise.all([
    eventInfo(db, b.event_type_id),
    partnerNameForEventType(db, b.event_type_id),
    db<{ label: Record<string, string> | null; question_key: string; value: string }[]>`
      select q.label, a.question_key, a.value
      from app.booking_answers a left join app.event_type_questions q on q.id = a.question_id
      where a.booking_id = ${b.id}
      order by q.position nulls last, a.question_key
    `,
  ]);
  return {
    hostName: host.name,
    hostEmail: host.email,
    timezone: host.timezone,
    eventName: info?.name ?? "",
    partnerName,
    start: b.start_at,
    end: b.end_at,
    inviteeName: b.invitee_name,
    inviteeEmail: b.invitee_email,
    inviteePhone: b.invitee_phone,
    answers: answers.map((a) => ({ label: pickLocalized(a.label, "en") || a.question_key, value: a.value })),
    meeting: meetingFor(b),
    bookingUrl: `${env().APP_BASE_URL}/bookings/${b.id}`,
    offsetMin,
    leadMin: effectiveLeadMin(b.start_at, offsetMin, now),
  };
}
