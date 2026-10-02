import "server-only";
import { z } from "zod";
import { service, serviceTx } from "@/server/db/client";
import { PermanentJobError, RetryAfterError, type JobContext, type JobHandler, type JobRow } from "@/server/jobs/types";
import {
  bookingFilter,
  graphClient,
  graphQuery,
  GraphError,
  GraphThrottledError,
  isGraphStatus,
  type GraphEvent,
  type GraphPage,
} from "@/server/graph/client";
import { CalendarConnectionBroken } from "@/server/graph/tokens";
import { decryptSecret } from "@/server/crypto/aes";
import { env } from "@/server/env";
import { buildCreatePayload, buildUpdatePayload, type EventPayloadInput, type LocationType } from "@/server/graph/event-payload";
import { ensureSubscription } from "@/server/graph/subscriptions";
import { syncDelta } from "@/server/graph/delta";

/** 4xx statuses that can succeed on a later attempt. */
const TRANSIENT_4XX = new Set([408, 409, 412, 423, 429]);

export function toJobError(err: unknown): unknown {
  if (err instanceof PermanentJobError || err instanceof RetryAfterError) return err;
  if (err instanceof CalendarConnectionBroken) {
    return new PermanentJobError(`Outlook connection unavailable (${err.message}). The user must reconnect Outlook.`, {
      reason: "calendar_connection_broken",
    });
  }
  if (err instanceof GraphThrottledError) return new RetryAfterError(err.message, err.retryAfterSeconds);
  if (err instanceof GraphError && err.status >= 400 && err.status < 500 && !TRANSIENT_4XX.has(err.status)) {
    return new PermanentJobError(err.message, { status: err.status, code: err.code });
  }
  return err;
}

function wrap(handler: JobHandler): JobHandler {
  return async (job, ctx) => {
    try {
      return await handler(job, ctx);
    } catch (err) {
      throw toJobError(err);
    }
  };
}

function parsePayload<T>(schema: z.ZodType<T>, job: JobRow): T {
  const parsed = schema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError(`Invalid ${job.kind} payload`);
  return parsed.data;
}

const bookingPayload = z.object({ bookingId: z.uuid() });
const userPayload = z.object({ userId: z.uuid() });
const deletePayload = z.object({ bookingId: z.uuid(), userId: z.uuid(), graphEventId: z.string().min(1).nullable().optional() });

// ---------------------------------------------------------------------------
// graph_event_upsert
// ---------------------------------------------------------------------------

type BookingRow = {
  id: string;
  status: string;
  language: string;
  start_at: Date;
  end_at: Date;
  invitee_name: string;
  invitee_email: string;
  invitee_phone: string | null;
  invitee_timezone: string;
  location_type: LocationType;
  location_detail: string | null;
  event_type_name: string;
  manage_token_enc: string | null;
};
type HostRow = { user_id: string; role: "primary" | "collective"; active: boolean; graph_event_id: string | null; email: string; name: string };

async function loadBooking(bookingId: string) {
  const sql = service();
  const [booking] = await sql<BookingRow[]>`
    select b.id, b.status, b.language, b.start_at, b.end_at, b.invitee_name, b.invitee_email, b.invitee_phone,
           b.invitee_timezone, b.location_type, b.location_detail, et.name as event_type_name, b.manage_token_enc
    from app.bookings b join app.event_types et on et.id = b.event_type_id
    where b.id = ${bookingId}
  `;
  if (!booking) return null;
  const hosts = await sql<HostRow[]>`
    select bh.user_id, bh.role, bh.active, bh.graph_event_id, u.email, u.name
    from app.booking_hosts bh join app.users u on u.id = bh.user_id
    where bh.booking_id = ${bookingId}
  `;
  const answers = await sql<{ question_key: string; value: string; label: Record<string, string> | null }[]>`
    select ba.question_key, ba.value, q.label
    from app.booking_answers ba left join app.event_type_questions q on q.id = ba.question_id
    where ba.booking_id = ${bookingId}
    order by q.position nulls last, ba.question_key
  `;
  return { booking, hosts, answers };
}

/** Invitee self-service link, rendered into the Outlook invite the invitee receives. */
function manageUrl(booking: BookingRow): string | null {
  if (!booking.manage_token_enc) return null;
  try {
    return `${env().APP_BASE_URL}/b/${decryptSecret(booking.manage_token_enc, booking.id)}`;
  } catch {
    return null;
  }
}

export function payloadInput(data: NonNullable<Awaited<ReturnType<typeof loadBooking>>>, primaryUserId: string): EventPayloadInput {
  const { booking, hosts, answers } = data;
  return {
    bookingId: booking.id,
    eventTypeName: booking.event_type_name,
    startAt: booking.start_at,
    endAt: booking.end_at,
    invitee: { name: booking.invitee_name, email: booking.invitee_email, phone: booking.invitee_phone, timezone: booking.invitee_timezone },
    locationType: booking.location_type,
    locationDetail: booking.location_detail,
    coHosts: hosts.filter((h) => h.active && h.user_id !== primaryUserId).map((h) => ({ name: h.name, email: h.email })),
    manageUrl: manageUrl(booking),
    answers: answers.map((a) => ({
      label: a.label?.[booking.language] ?? a.label?.en ?? a.question_key,
      value: a.value,
    })),
  };
}

const EVENT_SELECT = "id,iCalUId,onlineMeeting";

async function findTaggedEvent(userId: string, bookingId: string): Promise<GraphEvent | null> {
  const qs = graphQuery({ $filter: bookingFilter(bookingId), $select: EVENT_SELECT, $top: "1" });
  const res = await graphClient(userId).get<GraphPage<GraphEvent>>(`/me/events?${qs}`);
  return res.data?.value?.[0] ?? null;
}

async function upsertEvent(job: JobRow, ctx: JobContext) {
  const { bookingId } = parsePayload(bookingPayload, job);
  const data = await loadBooking(bookingId);
  if (!data) throw new PermanentJobError("Booking not found");
  if (data.booking.status !== "confirmed") {
    return { result: { skipped: `booking is ${data.booking.status}` } };
  }
  const primary = data.hosts.find((h) => h.role === "primary" && h.active);
  if (!primary) throw new PermanentJobError("Booking has no active primary host");

  const client = graphClient(primary.user_id);
  const input = payloadInput(data, primary.user_id);
  let event: GraphEvent | null = null;
  let op: "update" | "create" = "update";

  let targetId = primary.graph_event_id;
  if (!targetId) {
    // A previous attempt may have created the event and failed before storing its id.
    targetId = (await findTaggedEvent(primary.user_id, bookingId))?.id ?? null;
  }
  if (targetId) {
    try {
      event = (await client.patch<GraphEvent>(`/me/events/${encodeURIComponent(targetId)}`, buildUpdatePayload(input))).data;
    } catch (err) {
      if (!isGraphStatus(err, 404)) throw err;
      event = null;
    }
  }
  if (!event) {
    op = "create";
    event = (await client.post<GraphEvent>("/me/events", buildCreatePayload(input))).data;
  }
  if (!event?.id) throw new Error("Microsoft Graph returned no event id");

  let joinUrl = event.onlineMeeting?.joinUrl ?? null;
  if (input.locationType === "teams" && !joinUrl) {
    const fresh = await client.get<GraphEvent>(`/me/events/${encodeURIComponent(event.id)}?$select=${EVENT_SELECT}`);
    joinUrl = fresh.data?.onlineMeeting?.joinUrl ?? null;
  }
  ctx.log({ request: { op, locationType: input.locationType, attendees: 1 + input.coHosts.length }, responseCode: 200 });

  await serviceTx(async (tx) => {
    await tx`
      update app.booking_hosts set graph_event_id = ${event.id}, ical_uid = ${event.iCalUId ?? null}
      where booking_id = ${bookingId} and user_id = ${primary.user_id}
    `;
    if (event.iCalUId) {
      await tx`update app.booking_hosts set ical_uid = ${event.iCalUId} where booking_id = ${bookingId} and user_id <> ${primary.user_id}`;
    }
    if (joinUrl) {
      await tx`update app.bookings set online_meeting_url = ${joinUrl} where id = ${bookingId}`;
    }
  });
  return { result: { op, graphEventId: event.id, hasJoinUrl: Boolean(joinUrl) } };
}

// ---------------------------------------------------------------------------
// graph_event_delete
// ---------------------------------------------------------------------------

async function deleteEvent(job: JobRow, ctx: JobContext) {
  const { bookingId, userId, graphEventId } = parsePayload(deletePayload, job);
  let id = graphEventId ?? null;
  if (!id) {
    const [row] = await service()<{ graph_event_id: string | null }[]>`
      select graph_event_id from app.booking_hosts where booking_id = ${bookingId} and user_id = ${userId}
    `;
    id = row?.graph_event_id ?? null;
  }
  if (!id) id = (await findTaggedEvent(userId, bookingId))?.id ?? null;
  if (!id) return { result: { deleted: false, reason: "no event" } };

  let status = 204;
  try {
    // Deleting the organizer's copy sends cancellations to the attendees.
    await graphClient(userId).delete(`/me/events/${encodeURIComponent(id)}`);
  } catch (err) {
    if (!isGraphStatus(err, 404, 410)) throw err;
    status = 404;
  }
  ctx.log({ request: { op: "delete" }, responseCode: status });
  await service()`delete from app.busy_blocks where user_id = ${userId} and graph_event_id = ${id}`;
  return { result: { deleted: status === 204 } };
}

// ---------------------------------------------------------------------------
// graph_subscription_ensure and graph_delta_sync
// ---------------------------------------------------------------------------

async function ensureSub(job: JobRow) {
  const { userId } = parsePayload(userPayload, job);
  return { result: { outcome: await ensureSubscription(userId) } };
}

async function deltaSync(job: JobRow) {
  const { userId } = parsePayload(userPayload, job);
  const report = await syncDelta(userId);
  return {
    result: {
      mode: report.mode,
      upserted: report.upserted,
      deleted: report.deleted,
      conflicts: report.conflicts.length,
      ...(report.skipped ? { skipped: report.skipped } : {}),
    },
  };
}

/** Job handlers owned by the graph module. Keys are job kinds. */
export const graphHandlers: Record<string, JobHandler> = {
  graph_event_upsert: wrap(upsertEvent),
  graph_event_delete: wrap(deleteEvent),
  graph_subscription_ensure: wrap(ensureSub),
  graph_delta_sync: wrap(deltaSync),
};
