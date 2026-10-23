import "server-only";
import { z } from "zod";
import { service } from "@/server/db/client";
import { loadBookingHistory, type BookingHistoryEntry } from "@/server/audit-log";
import { decryptSecret } from "@/server/crypto/aes";
import { createBooking } from "@/server/booking/create";
import { rescheduleByInvitee } from "@/server/booking/manage";
import { cancelBookingAsHost } from "@/server/booking/host-actions";
import { bookingOptions } from "@/server/booking/providers";
import { loadEventTypeById } from "@/server/booking/load";
import { BookingError, BookingNotFoundError, BookingValidationError, SlotTakenError } from "@/server/booking/types";
import { ApiError, asCaller, inCallerContext, invalid, notFound, type Caller } from "@/server/api/context";
import { can } from "@/lib/permissions";

const iso = z.iso.datetime({ offset: true });
const uuid = z.string().uuid();

export const BOOKING_STATUSES = ["confirmed", "cancelled", "rescheduled", "flagged"] as const;

export const listBookingsSchema = z.object({
  from: iso.optional(),
  to: iso.optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  eventTypeId: uuid.optional(),
  /** Only bookings where the caller is a host, even for managers and admins. */
  mine: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10000).default(0),
});

export type BookingSummary = {
  id: string;
  status: string;
  start: string;
  end: string;
  language: string;
  eventType: { id: string; name: string; team: string | null };
  invitee: { name: string; email: string; phone: string | null; timezone: string };
  location: { type: string; detail: string | null; meetingUrl: string | null };
  hosts: { userId: string; name: string; email: string; role: string; active: boolean }[];
  createdVia: string;
  importedFrom: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  language: string;
  event_type_id: string;
  event_type_name: string;
  team_name: string | null;
  invitee_name: string;
  invitee_email: string;
  invitee_phone: string | null;
  invitee_timezone: string;
  location_type: string;
  location_detail: string | null;
  online_meeting_url: string | null;
  created_via: string;
  import_source: string | null;
  created_at: Date;
  hosts: BookingSummary["hosts"];
};

function toSummary(r: Row): BookingSummary {
  return {
    id: r.id,
    status: r.status,
    start: r.start_at.toISOString(),
    end: r.end_at.toISOString(),
    language: r.language,
    eventType: { id: r.event_type_id, name: r.event_type_name, team: r.team_name },
    invitee: { name: r.invitee_name, email: r.invitee_email, phone: r.invitee_phone, timezone: r.invitee_timezone },
    location: { type: r.location_type, detail: r.location_detail, meetingUrl: r.online_meeting_url },
    hosts: r.hosts,
    createdVia: r.created_via,
    importedFrom: r.import_source,
    createdAt: r.created_at.toISOString(),
  };
}

/** Bookings the caller may see (agents: their own; managers and admins: all), soonest first. */
export async function listBookings(caller: Caller, raw: z.input<typeof listBookingsSchema>): Promise<BookingSummary[]> {
  const parsed = listBookingsSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const q = parsed.data;
  const mineOnly = q.mine || !can(caller.user.role, "bookings.read_all");
  return asCaller(caller, async (tx) => {
    const rows = await tx<Row[]>`
      select b.id, b.status::text as status, b.start_at, b.end_at, b.language, b.event_type_id, et.name as event_type_name,
             t.name as team_name, b.invitee_name, b.invitee_email::text as invitee_email, b.invitee_phone, b.invitee_timezone,
             b.location_type::text as location_type, b.location_detail, b.online_meeting_url, b.created_via, b.import_source, b.created_at,
             coalesce((
               select json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email, 'role', bh.role, 'active', bh.active) order by bh.role, u.name)
               from app.booking_hosts bh join app.users u on u.id = bh.user_id
               where bh.booking_id = b.id and bh.reassigned_at is null
             ), '[]'::json) as hosts
      from app.bookings b
      join app.event_types et on et.id = b.event_type_id
      left join app.teams t on t.id = et.team_id
      where true
        ${q.from ? tx`and b.end_at > ${q.from}` : tx``}
        ${q.to ? tx`and b.start_at < ${q.to}` : tx``}
        ${q.status ? tx`and b.status = ${q.status}` : tx``}
        ${q.eventTypeId ? tx`and b.event_type_id = ${q.eventTypeId}` : tx``}
        ${mineOnly ? tx`and exists (select 1 from app.booking_hosts mh where mh.booking_id = b.id and mh.user_id = ${caller.user.id} and mh.reassigned_at is null)` : tx``}
      order by b.start_at, b.id
      limit ${q.limit} offset ${q.offset}
    `;
    return rows.map(toSummary);
  });
}

export type BookingDetail = BookingSummary & {
  answers: { key: string; label: string | null; value: string }[];
  cancelReason: string | null;
  cancelledBy: string | null;
  rescheduledFromId: string | null;
  /** The booking's audit history, oldest first, read under the caller's row-level security. */
  history: BookingHistoryEntry[];
};

export async function getBooking(caller: Caller, id: string): Promise<BookingDetail> {
  if (!uuid.safeParse(id).success) throw notFound("Booking");
  const detail = await asCaller(caller, async (tx) => {
    const [row] = await tx<(Row & { cancel_reason: string | null; cancelled_by: string | null; rescheduled_from_id: string | null })[]>`
      select b.id, b.status::text as status, b.start_at, b.end_at, b.language, b.event_type_id, et.name as event_type_name,
             t.name as team_name, b.invitee_name, b.invitee_email::text as invitee_email, b.invitee_phone, b.invitee_timezone,
             b.location_type::text as location_type, b.location_detail, b.online_meeting_url, b.created_via, b.import_source, b.created_at,
             b.cancel_reason, b.cancelled_by, b.rescheduled_from_id,
             coalesce((
               select json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email, 'role', bh.role, 'active', bh.active) order by bh.role, u.name)
               from app.booking_hosts bh join app.users u on u.id = bh.user_id
               where bh.booking_id = b.id and bh.reassigned_at is null
             ), '[]'::json) as hosts
      from app.bookings b
      join app.event_types et on et.id = b.event_type_id
      left join app.teams t on t.id = et.team_id
      where b.id = ${id}
    `;
    if (!row) return null;
    const answers = await tx<{ key: string; label: Record<string, string> | null; value: string }[]>`
      select a.question_key as key, q.label, a.value
      from app.booking_answers a left join app.event_type_questions q on q.id = a.question_id
      where a.booking_id = ${id}
      order by q.position nulls last, a.question_key
    `;
    const history = await loadBookingHistory(tx, id);
    return { row, answers, history };
  });
  if (!detail) throw notFound("Booking");
  const { row, answers, history } = detail;
  return {
    ...toSummary(row),
    answers: answers.map((a) => ({ key: a.key, label: a.label ? (a.label[row.language] ?? a.label.en ?? Object.values(a.label)[0] ?? null) : null, value: a.value })),
    cancelReason: row.cancel_reason,
    cancelledBy: row.cancelled_by,
    rescheduledFromId: row.rescheduled_from_id,
    history,
  };
}

export const scheduleSchema = z.object({
  eventTypeId: uuid,
  start: iso,
  durationMin: z.number().int().min(5).max(480).optional(),
  invitee: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(40).optional().nullable(),
    /**
     * Set true only when the invitee agreed to receive reminder texts at `phone`. Without it
     * the booking gets no merchant text reminders, even on pages that send them.
     */
    smsConsent: z
      .boolean()
      .optional()
      .describe("True only if the invitee agreed to receive reminder text messages at this phone number. Defaults to false."),
    timezone: z.string().min(1).max(64),
  }),
  answers: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

function mapBookingError(err: unknown): never {
  if (err instanceof BookingValidationError) throw new ApiError(400, "invalid_request", "The booking request is invalid.", { fields: err.fieldErrors });
  if (err instanceof SlotTakenError) throw new ApiError(409, "slot_unavailable", "That time is no longer available.");
  if (err instanceof BookingNotFoundError) throw notFound("Booking page");
  if (err instanceof BookingError) throw new ApiError(400, err.code, err.message);
  throw err;
}

/**
 * Schedules a meeting on an active booking page, exactly as if the invitee had booked it on
 * the public page: same availability checks, host assignment, Outlook event and emails.
 */
export async function scheduleBooking(caller: Caller, raw: unknown): Promise<BookingDetail> {
  const parsed = scheduleSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const v = parsed.data;
  const loaded = await loadEventTypeById(service(), v.eventTypeId);
  if (!loaded || !loaded.active) throw notFound("Active booking page");
  const et = loaded.resolved.eventType;
  let bookingId: string;
  try {
    const result = await inCallerContext(caller, () =>
      createBooking(
        {
          owner: { kind: loaded.owner.kind, slug: loaded.owner.slug },
          eventSlug: et.slug,
          language: et.language,
          start: v.start,
          durationMin: v.durationMin ?? et.default_duration,
          name: v.invitee.name,
          email: v.invitee.email,
          phone: v.invitee.phone ?? null,
          smsConsent: v.invitee.smsConsent === true,
          timezone: v.invitee.timezone,
          answers: v.answers,
          idempotencyKey: v.idempotencyKey ? `${caller.user.id}:${v.idempotencyKey}` : null,
        },
        // The engine writes the booking.create audit entry in its own transaction.
        { ...bookingOptions(), createdVia: caller.via === "mcp" ? "mcp" : "api", actorUserId: caller.user.id },
      ),
    );
    bookingId = result.bookingId;
  } catch (err) {
    mapBookingError(err);
  }
  return getBookingAsService(caller, bookingId!);
}

/**
 * A booking the caller just created may not be visible to them under RLS (for example an
 * agent booking a colleague's page). Return it from the service connection in that case.
 */
async function getBookingAsService(caller: Caller, id: string): Promise<BookingDetail> {
  try {
    return await getBooking(caller, id);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    const [row] = await service()<Row[]>`
      select b.id, b.status::text as status, b.start_at, b.end_at, b.language, b.event_type_id, et.name as event_type_name,
             t.name as team_name, b.invitee_name, b.invitee_email::text as invitee_email, b.invitee_phone, b.invitee_timezone,
             b.location_type::text as location_type, b.location_detail, b.online_meeting_url, b.created_via, b.import_source, b.created_at,
             '[]'::json as hosts
      from app.bookings b join app.event_types et on et.id = b.event_type_id left join app.teams t on t.id = et.team_id
      where b.id = ${id}
    `;
    if (!row) throw notFound("Booking");
    return { ...toSummary(row), answers: [], cancelReason: null, cancelledBy: null, rescheduledFromId: null, history: [] };
  }
}

export async function cancelBooking(caller: Caller, id: string, reason: string | null): Promise<BookingDetail> {
  if (!uuid.safeParse(id).success) throw notFound("Booking");
  const r = (reason ?? "").trim().slice(0, 500) || null;
  const res = await inCallerContext(caller, () => cancelBookingAsHost(caller.user.id, id, r));
  if (!res.ok) {
    if (res.reason === "not_found") throw notFound("Booking");
    if (res.reason === "imported") throw new ApiError(409, "imported", "This booking was imported from Calendly. Cancel or reschedule it in Calendly.");
    throw new ApiError(409, "not_cancellable", "This booking can no longer be cancelled.");
  }
  return getBooking(caller, id);
}

/**
 * Moves a booking to a new time through the same flow as the invitee's reschedule link, so
 * the invitee and hosts are notified and Outlook is updated. Only people who may change the
 * booking (its hosts, the page owner, team admins and admins) can do this.
 */
export async function rescheduleBooking(caller: Caller, id: string, raw: unknown): Promise<BookingDetail> {
  if (!uuid.safeParse(id).success) throw notFound("Booking");
  const parsed = z.object({ start: iso }).safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const allowed = await asCaller(caller, async (tx) => {
    const [r] = await tx<{ ok: boolean; exists: boolean }[]>`
      select app.can_write_booking(${id}) as ok, exists (select 1 from app.bookings where id = ${id}) as exists
    `;
    return r;
  });
  if (!allowed?.exists) throw notFound("Booking");
  if (!allowed.ok) throw new ApiError(403, "forbidden", "Only the booking's hosts, the page owner, team admins and admins can reschedule it.");
  const [b] = await service()<{ manage_token_enc: string | null; import_source: string | null }[]>`
    select manage_token_enc, import_source from app.bookings where id = ${id}
  `;
  if (b?.import_source) throw new ApiError(409, "imported", "This booking was imported from Calendly. Cancel or reschedule it in Calendly.");
  if (!b?.manage_token_enc) throw new ApiError(409, "not_reschedulable", "This booking cannot be rescheduled here.");
  try {
    // The engine writes the booking.reschedule audit entry in the same transaction as the move.
    const result = await inCallerContext(caller, () =>
      rescheduleByInvitee(decryptSecret(b.manage_token_enc!, id), { start: parsed.data.start }, { ...bookingOptions(), actorUserId: caller.user.id }),
    );
    return getBookingAsService(caller, result.bookingId);
  } catch (err) {
    mapBookingError(err);
  }
}
