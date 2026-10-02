import "server-only";
import type { Db } from "@/server/db/client";
import { isLocale, type Locale } from "@/i18n/locales";
import { eventPath } from "@/server/booking/load";
import type { PublicBookingView } from "@/server/booking/types";

/** Booking columns the service reads for views, emails and manage flows. */
export type BookingRow = {
  id: string;
  event_type_id: string;
  language: string;
  status: "confirmed" | "cancelled" | "rescheduled" | "flagged";
  start_at: Date;
  end_at: Date;
  invitee_name: string;
  invitee_email: string;
  invitee_phone: string | null;
  invitee_timezone: string;
  location_type: PublicBookingView["locationType"];
  location_detail: string | null;
  online_meeting_url: string | null;
  cancel_reason: string | null;
  rescheduled_from_id: string | null;
  sf_lead_id: string | null;
  sf_lead_status: string | null;
  created_at: Date;
};

export async function bookingById(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<BookingRow | null> {
  const [row] = await db<BookingRow[]>`
    select id, event_type_id, language, status, start_at, end_at, invitee_name, invitee_email,
           invitee_phone, invitee_timezone, location_type, location_detail, online_meeting_url,
           cancel_reason, rescheduled_from_id, sf_lead_id, sf_lead_status, created_at
    from app.bookings where id = ${id}
    ${opts.forUpdate ? db`for update` : db``}
  `;
  return row ?? null;
}

export async function bookingIdByTokenHash(db: Db, hash: string): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`select id from app.bookings where manage_token_hash = ${hash}`;
  return row?.id ?? null;
}

export type BookingHostRow = {
  user_id: string;
  name: string;
  email: string;
  photo_url: string | null;
  timezone: string;
  role: "primary" | "collective";
  active: boolean;
  graph_event_id: string | null;
  team_member_id: string | null;
};

/** Hosts of a booking, primary first. `activeOnly` limits to current assignments. */
export async function bookingHosts(db: Db, bookingId: string, activeOnly: boolean): Promise<BookingHostRow[]> {
  return db<BookingHostRow[]>`
    select bh.user_id, u.name, u.email, u.photo_url, u.timezone, bh.role, bh.active, bh.graph_event_id, bh.team_member_id
    from app.booking_hosts bh join app.users u on u.id = bh.user_id
    where bh.booking_id = ${bookingId} ${activeOnly ? db`and bh.active` : db``}
    order by (bh.role = 'primary') desc, u.name
  `;
}

type EventInfo = {
  name: string;
  slug: string;
  language: string;
  is_active: boolean;
  booking_window_days: number;
  owner_kind: "user" | "team";
  owner_slug: string | null;
  owner_active: boolean;
};

export async function eventInfo(db: Db, eventTypeId: string): Promise<EventInfo | null> {
  const [row] = await db<EventInfo[]>`
    select e.name, e.slug, e.language, e.is_active, e.booking_window_days,
           case when e.owner_user_id is not null then 'user' else 'team' end as owner_kind,
           coalesce(u.slug, t.slug) as owner_slug,
           coalesce(u.is_active, true) as owner_active
    from app.event_types e
    left join app.users u on u.id = e.owner_user_id
    left join app.teams t on t.id = e.team_id
    where e.id = ${eventTypeId}
  `;
  return row ?? null;
}

/** Public-safe view of a booking for the invitee holding its manage token. */
export async function buildPublicView(db: Db, booking: BookingRow, now = Date.now()): Promise<PublicBookingView> {
  const [info, hosts] = await Promise.all([
    eventInfo(db, booking.event_type_id),
    bookingHosts(db, booking.id, booking.status === "confirmed" || booking.status === "flagged"),
  ]);
  const language: Locale = isLocale(booking.language) ? booking.language : "en";
  const isPast = booking.start_at.getTime() <= now;
  // "flagged" is an internal state; the invitee still has a confirmed meeting.
  const status = booking.status === "flagged" ? "confirmed" : booking.status;
  const live = status === "confirmed" && !isPast;
  const bookable = !!info && info.is_active && info.owner_active && !!info.owner_slug;
  return {
    status,
    isPast,
    start: booking.start_at.toISOString(),
    end: booking.end_at.toISOString(),
    durationMin: Math.round((booking.end_at.getTime() - booking.start_at.getTime()) / 60_000),
    language,
    eventName: info?.name ?? "",
    eventPath: bookable ? eventPath(info!.owner_kind, info!.owner_slug!, info!.slug, info!.language) : null,
    inviteeName: booking.invitee_name,
    inviteeTimezone: booking.invitee_timezone,
    hosts: hosts.map((h) => ({ name: h.name, photoUrl: h.photo_url })),
    locationType: booking.location_type,
    locationDetail: booking.location_type === "teams" ? null : booking.location_detail,
    onlineMeetingUrl: booking.online_meeting_url,
    canCancel: live,
    canReschedule: live && bookable,
    windowEnd: info ? new Date(now + (info.booking_window_days + 1) * 86_400_000).toISOString() : null,
    createdAt: booking.created_at.toISOString(),
  };
}

/** First booking in a reschedule chain and the chain depth (ICS UID and SEQUENCE). */
export async function chainRoot(sql: Db, bookingId: string): Promise<{ rootId: string; depth: number }> {
  const rows = await sql<{ id: string; depth: number }[]>`
    with recursive chain as (
      select id, rescheduled_from_id, 0 as depth from app.bookings where id = ${bookingId}
      union all
      select b.id, b.rescheduled_from_id, c.depth + 1
      from app.bookings b join chain c on b.id = c.rescheduled_from_id
      where c.depth < 50
    )
    select id, depth from chain order by depth desc limit 1
  `;
  return { rootId: rows[0]?.id ?? bookingId, depth: rows[0]?.depth ?? 0 };
}
