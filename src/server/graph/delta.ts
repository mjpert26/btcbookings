import "server-only";
import { DateTime } from "luxon";
import { service, serviceTx, type Tx } from "@/server/db/client";
import { decryptSecret, encryptSecret } from "@/server/crypto/aes";
import { writeAudit } from "@/server/audit";
import { enqueue } from "@/server/jobs/queue";
import { GraphError, graphQuery, type GraphEvent } from "@/server/graph/client";
import { CalendarConnectionBroken } from "@/server/graph/tokens";
import { deltaBucket } from "@/server/graph/subscriptions";
import {
  collectPages,
  graphUtc,
  parseEvent,
  resolveOwnBookings,
  upsertBusyBlocks,
  UTC_PREFER,
  type ParsedEvent,
} from "@/server/graph/busy";

/**
 * Delta reconciliation of the busy_blocks cache over a rolling window, plus detection of
 * Outlook-side changes to the app's own events.
 *
 * A calendarView delta link is bound to the window it was issued for. When the rolling
 * window moves (once a day) or Graph rejects the stored link (410 Gone, syncStateNotFound),
 * the sync starts over with a full round for the current window.
 */
export const WINDOW_PAST_DAYS = 1;
export const WINDOW_FUTURE_DAYS = 60;
/** Tolerance when comparing an Outlook event's times with the booking's. */
const MOVE_TOLERANCE_MS = 60_000;

const RESYNC_CODES = new Set(["syncStateNotFound", "syncStateInvalid", "resyncRequired", "SyncStateNotFound"]);

export function deltaWindow(now = new Date()): { start: Date; end: Date } {
  const today = DateTime.fromJSDate(now, { zone: "UTC" }).startOf("day");
  return {
    start: today.minus({ days: WINDOW_PAST_DAYS }).toJSDate(),
    end: today.plus({ days: WINDOW_FUTURE_DAYS }).toJSDate(),
  };
}

export function isResyncError(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false;
  if (err.status === 410) return true;
  return err.status >= 400 && err.status < 500 && err.code !== null && RESYNC_CODES.has(err.code);
}

export type ConflictKind = "deleted" | "moved";
export type ConflictAction = { bookingId: string; kind: ConflictKind; policy: "auto_cancel" | "flag" };
export type DeltaReport = {
  mode: "full" | "incremental";
  upserted: number;
  deleted: number;
  conflicts: ConflictAction[];
  skipped?: "superseded";
};

function initialDeltaUrl(start: Date, end: Date): string {
  const qs = graphQuery({ startDateTime: graphUtc(start) + "Z", endDateTime: graphUtc(end) + "Z" });
  return `/me/calendarView/delta?${qs}`;
}

export async function syncDelta(userId: string, now = new Date()): Promise<DeltaReport> {
  const [conn] = await service()<
    { status: string; delta_link_enc: string | null; delta_window_start: Date | null; delta_window_end: Date | null }[]
  >`
    select status, delta_link_enc, delta_window_start, delta_window_end
    from app.calendar_connections where user_id = ${userId}
  `;
  if (!conn) throw new CalendarConnectionBroken(userId, "No Outlook connection");
  if (conn.status !== "healthy") throw new CalendarConnectionBroken(userId, `Outlook connection is ${conn.status}`);

  const window = deltaWindow(now);
  const sameWindow =
    conn.delta_window_start?.getTime() === window.start.getTime() && conn.delta_window_end?.getTime() === window.end.getTime();

  let storedLink: string | null = null;
  if (conn.delta_link_enc && sameWindow) {
    try {
      storedLink = decryptSecret(conn.delta_link_enc, userId);
    } catch {
      // Undecryptable (e.g. its key was retired): start over with a full round.
      storedLink = null;
    }
  }
  let mode: "full" | "incremental" = storedLink ? "incremental" : "full";
  let result: { items: GraphEvent[]; deltaLink: string | null };
  if (storedLink) {
    try {
      result = await collectPages<GraphEvent>(userId, storedLink, UTC_PREFER);
    } catch (err) {
      if (!isResyncError(err)) throw err;
      mode = "full";
      result = await collectPages<GraphEvent>(userId, initialDeltaUrl(window.start, window.end), UTC_PREFER);
    }
  } else {
    result = await collectPages<GraphEvent>(userId, initialDeltaUrl(window.start, window.end), UTC_PREFER);
  }
  if (!result.deltaLink) throw new Error("Delta round ended without a deltaLink");

  // The same event can appear more than once in a round; the last occurrence wins.
  const latest = new Map<string, { removed: true } | { removed: false; event: ParsedEvent }>();
  for (const item of result.items) {
    if (!item?.id) continue;
    const parsed = parseEvent(item);
    latest.set(item.id, parsed ? { removed: false, event: parsed } : { removed: true });
  }
  const present: ParsedEvent[] = [];
  const removedIds: string[] = [];
  for (const [id, state] of latest) {
    if (state.removed) removedIds.push(id);
    // Incremental rounds can include events outside the window; they are not cached.
    else if (state.event.startAt < window.end && state.event.endAt > window.start) present.push(state.event);
    else removedIds.push(id);
  }

  const startedFrom = conn.delta_link_enc;
  return serviceTx(async (tx) => {
    const [locked] = await tx<{ delta_link_enc: string | null }[]>`
      select delta_link_enc from app.calendar_connections where user_id = ${userId} for update
    `;
    if ((locked?.delta_link_enc ?? null) !== (startedFrom ?? null)) {
      // Another sync for this user committed first; its state is at least as new.
      return { mode, upserted: 0, deleted: 0, conflicts: [], skipped: "superseded" as const };
    }

    const own = await resolveOwnBookings(tx, userId, present);
    const upserted = await upsertBusyBlocks(tx, userId, present, own);
    let deleted = 0;
    if (removedIds.length) {
      deleted += (await tx`delete from app.busy_blocks where user_id = ${userId} and graph_event_id = any(${removedIds}::text[])`).count;
    }
    if (mode === "full") {
      const keep = present.map((e) => e.graphEventId);
      deleted += (
        await tx`
          delete from app.busy_blocks
          where user_id = ${userId} and start_at < ${window.end} and end_at > ${window.start}
            and not (graph_event_id = any(${keep}::text[]))
        `
      ).count;
    }

    const conflicts = await detectConflicts(tx, userId, mode, window, latest);

    await tx`
      update app.calendar_connections set
        delta_link_enc = ${encryptSecret(result.deltaLink!, userId)},
        delta_window_start = ${window.start},
        delta_window_end = ${window.end},
        last_synced_at = now(),
        last_error = null
      where user_id = ${userId}
    `;
    return { mode, upserted, deleted, conflicts };
  });
}

/** Enqueues graph_delta_sync for every healthy connection (the 15-minute cron). */
export async function enqueueDeltaForHealthy(now = Date.now()): Promise<number> {
  const sql = service();
  const rows = await sql<{ user_id: string }[]>`select user_id from app.calendar_connections where status = 'healthy'`;
  let n = 0;
  for (const r of rows) {
    const id = await enqueue(sql, {
      kind: "graph_delta_sync",
      payload: { userId: r.user_id },
      idempotencyKey: `delta:${r.user_id}:${deltaBucket(now)}`,
    });
    if (id) n++;
  }
  return n;
}

type Candidate = {
  booking_id: string;
  graph_event_id: string;
  start_at: Date;
  end_at: Date;
  in_flight: boolean;
};

/**
 * Finds the app's own events (on this user's calendar, where the user is the primary host)
 * that were deleted or moved in Outlook while the booking is confirmed.
 *
 * Changes the app made itself are ignored: a cancelled or rescheduled booking is no longer
 * confirmed, and a booking whose Outlook update is still queued (graph_event_upsert pending,
 * running or awaiting retry) is skipped until the job has written the new times.
 */
async function detectConflicts(
  tx: Tx,
  userId: string,
  mode: "full" | "incremental",
  window: { start: Date; end: Date },
  latest: Map<string, { removed: true } | { removed: false; event: ParsedEvent }>,
): Promise<ConflictAction[]> {
  const touched = [...latest.keys()];
  if (mode === "incremental" && touched.length === 0) return [];
  const candidates = await tx<Candidate[]>`
    select bh.booking_id, bh.graph_event_id, b.start_at, b.end_at,
           exists (
             select 1 from app.jobs j
             where j.kind = 'graph_event_upsert' and j.booking_id = b.id
               and j.status in ('pending', 'running', 'failed')
           ) as in_flight
    from app.booking_hosts bh
    join app.bookings b on b.id = bh.booking_id
    where bh.user_id = ${userId} and bh.role = 'primary' and bh.active
      and b.status = 'confirmed' and bh.graph_event_id is not null
      and (
        bh.graph_event_id = any(${touched}::text[])
        or (${mode === "full"}::boolean and b.start_at < ${window.end} and b.end_at > ${window.start})
      )
    for update of b
  `;

  const actions: ConflictAction[] = [];
  for (const c of candidates) {
    const state = latest.get(c.graph_event_id);
    let kind: ConflictKind | null = null;
    if (!state) {
      // Only reachable in a full round: the event is not in Outlook any more.
      kind = mode === "full" ? "deleted" : null;
    } else if (state.removed) {
      kind = "deleted";
    } else if (
      !c.in_flight &&
      (Math.abs(state.event.startAt.getTime() - c.start_at.getTime()) > MOVE_TOLERANCE_MS ||
        Math.abs(state.event.endAt.getTime() - c.end_at.getTime()) > MOVE_TOLERANCE_MS)
    ) {
      kind = "moved";
    }
    if (kind) actions.push(await applyConflictPolicy(tx, c.booking_id, userId, c.graph_event_id, kind));
  }
  return actions;
}

/** Team event types use the team's policy; individual ones use the owner's user_settings. */
async function conflictPolicyFor(tx: Tx, bookingId: string): Promise<"auto_cancel" | "flag"> {
  const [row] = await tx<{ policy: "auto_cancel" | "flag" | null }[]>`
    select coalesce(t.outlook_conflict_policy, us.outlook_conflict_policy) as policy
    from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    left join app.teams t on t.id = et.team_id
    left join app.user_settings us on us.user_id = et.owner_user_id
    where b.id = ${bookingId}
  `;
  return row?.policy ?? "flag";
}

export async function applyConflictPolicy(
  tx: Tx,
  bookingId: string,
  primaryUserId: string,
  graphEventId: string,
  kind: ConflictKind,
): Promise<ConflictAction> {
  const policy = await conflictPolicyFor(tx, bookingId);
  const reason =
    kind === "deleted" ? "The event was deleted from the host's Outlook calendar." : "The event was moved in the host's Outlook calendar.";

  if (policy === "auto_cancel") {
    await tx`
      update app.bookings
      set status = 'cancelled', cancelled_by = 'host', cancelled_at = now(), cancel_reason = ${reason}
      where id = ${bookingId} and status = 'confirmed'
    `;
    await tx`update app.booking_hosts set active = false where booking_id = ${bookingId}`;
    await enqueue(tx, {
      kind: "email_send",
      payload: { template: "booking_cancelled", bookingId, recipient: "invitee" },
      idempotencyKey: `booking_cancelled:${bookingId}`,
      bookingId,
    });
    if (kind === "moved") {
      // The event still exists at the new time; cancel it so attendees' calendars match.
      await enqueue(tx, {
        kind: "graph_event_delete",
        payload: { bookingId, userId: primaryUserId, graphEventId },
        idempotencyKey: `delete:${bookingId}:${primaryUserId}:outlook_conflict`,
        bookingId,
      });
    }
  } else {
    await tx`
      update app.bookings set status = 'flagged', flagged_reason = ${reason}
      where id = ${bookingId} and status = 'confirmed'
    `;
    await enqueue(tx, {
      kind: "email_send",
      payload: { template: "host_conflict_flagged", bookingId, recipient: { userId: primaryUserId } },
      idempotencyKey: `host_conflict_flagged:${bookingId}:${kind}`,
      bookingId,
    });
  }
  await writeAudit(tx, {
    actorUserId: null,
    action: policy === "auto_cancel" ? "booking.outlook_conflict_cancelled" : "booking.outlook_conflict_flagged",
    entityType: "booking",
    entityId: bookingId,
    after: { kind, policy },
  });
  return { bookingId, kind, policy };
}
