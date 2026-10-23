import "server-only";
import type { Db } from "@/server/db/client";
import { partnerDisplayName } from "@/server/email/partner";

export const WEBHOOK_EVENTS = ["booking.created", "booking.rescheduled", "booking.cancelled", "booking.reassigned"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  "booking.created": "Booking created",
  "booking.rescheduled": "Booking rescheduled (the new booking)",
  "booking.cancelled": "Booking cancelled",
  "booking.reassigned": "Booking reassigned to another host",
};

export function isWebhookEvent(v: string): v is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

type BookingRow = {
  id: string;
  status: string;
  created_via: string;
  language: string;
  start_at: Date;
  end_at: Date;
  invitee_name: string;
  invitee_email: string;
  invitee_phone: string | null;
  invitee_timezone: string;
  location_type: string;
  location_detail: string | null;
  online_meeting_url: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  cancelled_at: Date | null;
  rescheduled_from_id: string | null;
  created_at: Date;
  event_type_id: string;
  event_type_name: string;
  event_type_slug: string;
  team_id: string | null;
  team_name: string | null;
  team_slug: string | null;
  team_display_name: string | null;
};

/**
 * The JSON body sent for a booking event. Contains what an integration needs to act on the
 * booking; never manage tokens, Salesforce ids, routing weights or internal flags.
 */
export async function buildBookingEventBody(
  db: Db,
  input: { bookingId: string; event: WebhookEvent; eventId: string; occurredAt: string },
): Promise<Record<string, unknown> | null> {
  const [b] = await db<BookingRow[]>`
    select b.id, b.status, b.created_via, b.language, b.start_at, b.end_at, b.invitee_name, b.invitee_email::text as invitee_email,
           b.invitee_phone, b.invitee_timezone, b.location_type, b.location_detail, b.online_meeting_url,
           b.cancelled_by, b.cancel_reason, b.cancelled_at, b.rescheduled_from_id, b.created_at,
           et.id as event_type_id, et.name as event_type_name, et.slug as event_type_slug,
           t.id as team_id, t.name as team_name, t.slug as team_slug, t.page_settings->>'displayName' as team_display_name
    from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    left join app.teams t on t.id = et.team_id
    where b.id = ${input.bookingId}
  `;
  if (!b) return null;
  const hosts = await db<{ name: string; email: string; role: string; active: boolean }[]>`
    select u.name, u.email::text as email, bh.role, bh.active
    from app.booking_hosts bh join app.users u on u.id = bh.user_id
    where bh.booking_id = ${b.id}
    order by bh.active desc, (bh.role = 'primary') desc, u.name
  `;
  const answers = await db<{ key: string; label: Record<string, string> | null; value: string }[]>`
    select ba.question_key as key, q.label, ba.value
    from app.booking_answers ba left join app.event_type_questions q on q.id = ba.question_id
    where ba.booking_id = ${b.id}
    order by q.position nulls last, ba.question_key
  `;
  return {
    id: input.eventId,
    type: input.event,
    createdAt: input.occurredAt,
    data: {
      booking: {
        id: b.id,
        status: b.status,
        createdVia: b.created_via,
        language: b.language,
        start: b.start_at.toISOString(),
        end: b.end_at.toISOString(),
        createdAt: b.created_at.toISOString(),
        rescheduledFromId: b.rescheduled_from_id,
        eventType: { id: b.event_type_id, name: b.event_type_name, slug: b.event_type_slug },
        team: b.team_id
          ? { id: b.team_id, name: b.team_name, slug: b.team_slug, partnerName: partnerDisplayName({ name: b.team_name ?? "" }, b.team_display_name) }
          : null,
        invitee: { name: b.invitee_name, email: b.invitee_email, phone: b.invitee_phone, timezone: b.invitee_timezone },
        location: { type: b.location_type, detail: b.location_detail, joinUrl: b.online_meeting_url },
        hosts: hosts.map((h) => ({ name: h.name, email: h.email, role: h.role, active: h.active })),
        answers: answers.map((a) => ({ key: a.key, label: a.label?.en ?? a.label?.es ?? a.key, value: a.value })),
        cancellation: b.cancelled_at ? { by: b.cancelled_by, reason: b.cancel_reason, at: b.cancelled_at.toISOString() } : null,
      },
    },
  };
}

/** Body of a test delivery sent from Admin > Webhooks. */
export function testEventBody(eventId: string, occurredAt: string): Record<string, unknown> {
  return { id: eventId, type: "webhook.test", createdAt: occurredAt, data: { message: "Test delivery from BTC Scheduler." } };
}
