import "server-only";
import { DateTime } from "luxon";
import { service, serviceTx, type Db, type Tx } from "@/server/db/client";
import {
  BOOKING_PROP_ID,
  EXPAND_BOOKING_PROP,
  graphClient,
  graphQuery,
  type DateTimeTimeZone,
  type GraphEvent,
  type GraphPage,
} from "@/server/graph/client";
import { windowsToIana } from "@/server/graph/timezones";
import type { BusyBlock } from "@/server/scheduling/types";

/** Upper bound on pages followed in one listing, as a guard against a looping nextLink. */
export const MAX_PAGES = 200;
const PAGE_SIZE = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Graph event normalized for the busy_blocks cache. */
export type ParsedEvent = {
  graphEventId: string;
  icalUid: string | null;
  startAt: Date;
  endAt: Date;
  showAs: string;
  isAllDay: boolean;
  /** Booking id read from the extended property or transactionId, when present. */
  taggedBookingId: string | null;
};

/** Parses a Graph dateTimeTimeZone. The app requests UTC, but other zones are handled. */
export function parseGraphDateTime(v: DateTimeTimeZone | null | undefined): Date | null {
  if (!v?.dateTime) return null;
  const zone = !v.timeZone || v.timeZone === "UTC" || v.timeZone === "tzone://Microsoft/Utc" ? "UTC" : windowsToIana(v.timeZone);
  const dt = DateTime.fromISO(v.dateTime, { zone });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Formats a UTC instant for Graph request bodies and query strings. */
export function graphUtc(d: Date | number): string {
  return DateTime.fromMillis(typeof d === "number" ? d : d.getTime(), { zone: "UTC" }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export function taggedBookingId(e: GraphEvent): string | null {
  const prop = e.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === BOOKING_PROP_ID.toLowerCase());
  const candidate = prop?.value ?? e.transactionId ?? null;
  return candidate && UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

/** Returns null for removed, cancelled or malformed events (callers treat them as absent). */
export function parseEvent(e: GraphEvent): ParsedEvent | null {
  if (e["@removed"] || e.isCancelled) return null;
  const startAt = parseGraphDateTime(e.start);
  const endAt = parseGraphDateTime(e.end);
  if (!startAt || !endAt || endAt <= startAt) return null;
  return {
    graphEventId: e.id,
    icalUid: e.iCalUId ?? null,
    startAt,
    endAt,
    showAs: (e.showAs ?? "busy").toString(),
    isAllDay: Boolean(e.isAllDay),
    taggedBookingId: taggedBookingId(e),
  };
}

/**
 * Resolves which cached events belong to the app's own bookings: by the tag on the event,
 * by the event id stored on booking_hosts, or by iCalUId (the copy of a collective event on
 * another host's calendar has a different id but the same iCalUId).
 */
export async function resolveOwnBookings(db: Db, userId: string, events: ParsedEvent[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (events.length === 0) return out;
  const ids = events.map((e) => e.graphEventId);
  const icals = events.map((e) => e.icalUid).filter((v): v is string => Boolean(v));
  const tagged = events.map((e) => e.taggedBookingId).filter((v): v is string => Boolean(v));

  const rows = await db<{ booking_id: string; graph_event_id: string | null; ical_uid: string | null; user_id: string }[]>`
    select booking_id, graph_event_id, ical_uid, user_id from app.booking_hosts
    where (user_id = ${userId} and graph_event_id = any(${ids}::text[]))
       or (ical_uid = any(${icals}::text[]))
       or (user_id = ${userId} and booking_id = any(${tagged}::uuid[]))
  `;
  const byEventId = new Map<string, string>();
  const byIcal = new Map<string, string>();
  const userBookings = new Set<string>();
  for (const r of rows) {
    if (r.user_id === userId && r.graph_event_id) byEventId.set(r.graph_event_id, r.booking_id);
    if (r.ical_uid) byIcal.set(r.ical_uid, r.booking_id);
    if (r.user_id === userId) userBookings.add(r.booking_id);
  }
  for (const e of events) {
    const id =
      byEventId.get(e.graphEventId) ??
      (e.taggedBookingId && userBookings.has(e.taggedBookingId) ? e.taggedBookingId : undefined) ??
      (e.icalUid ? byIcal.get(e.icalUid) : undefined);
    if (id) out.set(e.graphEventId, id);
  }
  return out;
}

export async function upsertBusyBlocks(tx: Tx, userId: string, events: ParsedEvent[], own: Map<string, string>): Promise<number> {
  let n = 0;
  for (const e of events) {
    await tx`
      insert into app.busy_blocks (user_id, graph_event_id, ical_uid, start_at, end_at, show_as, is_all_day, booking_id)
      values (${userId}, ${e.graphEventId}, ${e.icalUid}, ${e.startAt}, ${e.endAt}, ${e.showAs}, ${e.isAllDay},
              ${own.get(e.graphEventId) ?? null})
      on conflict (user_id, graph_event_id) do update set
        ical_uid = excluded.ical_uid, start_at = excluded.start_at, end_at = excluded.end_at,
        show_as = excluded.show_as, is_all_day = excluded.is_all_day, booking_id = excluded.booking_id
    `;
    n++;
  }
  return n;
}

/** Follows @odata.nextLink pages until a page has none (or a deltaLink). */
export async function collectPages<T>(
  userId: string,
  firstUrl: string,
  headers: Record<string, string>,
): Promise<{ items: T[]; deltaLink: string | null }> {
  const client = graphClient(userId);
  const items: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error("Microsoft Graph paging exceeded the page limit");
    const res: { data: GraphPage<T> } = await client.get<GraphPage<T>>(url, { headers });
    items.push(...(res.data?.value ?? []));
    if (res.data?.["@odata.deltaLink"]) return { items, deltaLink: res.data["@odata.deltaLink"] };
    url = res.data?.["@odata.nextLink"];
  }
  return { items, deltaLink: null };
}

export const UTC_PREFER = { prefer: `outlook.timezone="UTC", odata.maxpagesize=${PAGE_SIZE}` };

/**
 * Reads the user's calendarView for [from, to) and makes busy_blocks match it exactly in
 * that window: upserts every event and deletes cached rows in the window that no longer exist.
 */
export async function syncCalendarWindow(userId: string, from: Date, to: Date): Promise<{ upserted: number; deleted: number }> {
  const qs = graphQuery({
    startDateTime: graphUtc(from) + "Z",
    endDateTime: graphUtc(to) + "Z",
    $select: "id,iCalUId,start,end,showAs,isAllDay,isCancelled,transactionId,type",
    $expand: EXPAND_BOOKING_PROP,
  });
  const { items } = await collectPages<GraphEvent>(userId, `/me/calendarView?${qs}`, UTC_PREFER);
  const parsed = items.map(parseEvent).filter((e): e is ParsedEvent => e !== null);

  return serviceTx(async (tx) => {
    const own = await resolveOwnBookings(tx, userId, parsed);
    const upserted = await upsertBusyBlocks(tx, userId, parsed, own);
    const keep = parsed.map((e) => e.graphEventId);
    const deleted = await tx`
      delete from app.busy_blocks
      where user_id = ${userId} and start_at < ${to} and end_at > ${from}
        and not (graph_event_id = any(${keep}::text[]))
    `;
    await tx`update app.calendar_connections set last_synced_at = now() where user_id = ${userId}`;
    return { upserted, deleted: deleted.count };
  });
}

// ---------------------------------------------------------------------------
// Live free/busy for the booking pre-check
// ---------------------------------------------------------------------------

type ScheduleItem = { status?: string; start?: DateTimeTimeZone; end?: DateTimeTimeZone };
type ScheduleInfo = { scheduleId?: string; scheduleItems?: ScheduleItem[]; error?: { message?: string } };

export const LIVE_FREE_BUSY_TIMEOUT_MS = 2000;

export async function cachedBusy(userIds: string[], from: Date, to: Date): Promise<Record<string, BusyBlock[]>> {
  const out: Record<string, BusyBlock[]> = Object.fromEntries(userIds.map((id) => [id, [] as BusyBlock[]]));
  if (userIds.length === 0) return out;
  const rows = await service()<{ user_id: string; start_at: Date; end_at: Date; show_as: string; is_all_day: boolean }[]>`
    select user_id, start_at, end_at, show_as, is_all_day from app.busy_blocks
    where user_id = any(${userIds}::uuid[]) and start_at < ${to} and end_at > ${from}
    order by start_at
  `;
  for (const r of rows) {
    out[r.user_id].push({ start: r.start_at.getTime(), end: r.end_at.getTime(), showAs: r.show_as, isAllDay: r.is_all_day });
  }
  return out;
}

async function scheduleFor(userId: string, email: string, from: Date, to: Date, timeoutMs: number): Promise<BusyBlock[]> {
  const res = await graphClient(userId).post<{ value?: ScheduleInfo[] }>(
    "/me/calendar/getSchedule",
    {
      schedules: [email],
      startTime: { dateTime: graphUtc(from), timeZone: "UTC" },
      endTime: { dateTime: graphUtc(to), timeZone: "UTC" },
      availabilityViewInterval: 15,
    },
    { headers: { prefer: 'outlook.timezone="UTC"' }, timeoutMs, maxRetries: 0 },
  );
  const info = res.data?.value?.[0];
  if (!info || info.error) throw new Error("getSchedule returned no schedule");
  const blocks: BusyBlock[] = [];
  for (const item of info.scheduleItems ?? []) {
    const s = parseGraphDateTime(item.start);
    const e = parseGraphDateTime(item.end);
    const status = item.status ?? "busy";
    if (!s || !e || e <= s || status === "free") continue;
    blocks.push({ start: s.getTime(), end: e.getTime(), showAs: status, isAllDay: false });
  }
  return blocks;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

export type LiveBusyResult = { blocks: Record<string, BusyBlock[]>; source: Record<string, "live" | "cache"> };

/**
 * Live free/busy for the booking pre-check. Calls getSchedule with each host's own token in
 * parallel (each bounded by a 2-second timeout, including any token refresh) and falls back
 * to the busy_blocks cache for any host whose call fails or times out.
 */
export async function liveFreeBusyDetailed(
  userIds: string[],
  from: Date,
  to: Date,
  timeoutMs = LIVE_FREE_BUSY_TIMEOUT_MS,
): Promise<LiveBusyResult> {
  const blocks: Record<string, BusyBlock[]> = {};
  const source: Record<string, "live" | "cache"> = {};
  if (userIds.length === 0) return { blocks, source };
  const users = await service()<{ id: string; email: string }[]>`
    select u.id, u.email from app.users u
    join app.calendar_connections c on c.user_id = u.id and c.status = 'healthy'
    where u.id = any(${userIds}::uuid[])
  `;
  const emails = new Map(users.map((u) => [u.id, u.email]));
  const results = await Promise.allSettled(
    userIds.map((id) => {
      const email = emails.get(id);
      if (!email) return Promise.reject(new Error("no healthy connection"));
      return withTimeout(scheduleFor(id, email, from, to, timeoutMs), timeoutMs);
    }),
  );
  const fallback: string[] = [];
  results.forEach((r, i) => {
    const id = userIds[i];
    if (r.status === "fulfilled") {
      blocks[id] = r.value;
      source[id] = "live";
    } else {
      fallback.push(id);
    }
  });
  if (fallback.length) {
    const cached = await cachedBusy(fallback, from, to);
    for (const id of fallback) {
      blocks[id] = cached[id] ?? [];
      source[id] = "cache";
    }
  }
  return { blocks, source };
}

/** BusyBlock[] per user id for [from, to). See liveFreeBusyDetailed. */
export async function liveFreeBusy(userIds: string[], from: Date, to: Date): Promise<Record<string, BusyBlock[]>> {
  return (await liveFreeBusyDetailed(userIds, from, to)).blocks;
}
