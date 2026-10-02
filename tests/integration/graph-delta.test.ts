import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { graphError, installGraphMock, json, resetGraph, type GraphMock } from "../helpers/graph-mock";
import { makeBooking, makeIndividualEventType, makeTeamEventType } from "../helpers/booking-fixtures";
import type { Sql } from "@/server/db/client";
import { decryptSecret, encryptSecret } from "@/server/crypto/aes";
import { enqueue } from "@/server/jobs/queue";
import { syncDelta, deltaWindow } from "@/server/graph/delta";
import { syncCalendarWindow, liveFreeBusyDetailed } from "@/server/graph/busy";
import { BOOKING_PROP_ID } from "@/server/graph/client";

let sql: Sql;
let mock: GraphMock;
beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  resetGraph();
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  mock = installGraphMock();
});
afterEach(() => resetGraph());

const NOW = new Date("2026-10-10T12:00:00Z");
const INITIAL = /\/me\/calendarView\/delta\?startDateTime=/;
const LINK_1 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=token-one";
const LINK_2 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=token-two";
const LINK_1_RE = /\$deltatoken=token-one$/;

const ev = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id,
  iCalUId: `ical-${id}`,
  start: { dateTime: `${start}.0000000`, timeZone: "UTC" },
  end: { dateTime: `${end}.0000000`, timeZone: "UTC" },
  showAs: "busy",
  isAllDay: false,
  isCancelled: false,
  ...extra,
});
const removed = (id: string) => ({ id, "@removed": { reason: "deleted" } });

async function blocks(userId: string) {
  return sql<{ graph_event_id: string; start_at: Date; show_as: string; booking_id: string | null }[]>`
    select graph_event_id, start_at, show_as, booking_id from app.busy_blocks where user_id = ${userId} order by graph_event_id
  `;
}

async function withDeltaState(userId: string, link = LINK_1) {
  const w = deltaWindow(NOW);
  await sql`
    update app.calendar_connections set delta_link_enc = ${encryptSecret(link, userId)},
      delta_window_start = ${w.start}, delta_window_end = ${w.end}
    where user_id = ${userId}
  `;
}

describe("delta sync", () => {
  it("runs a full round, pages through nextLink, and reconciles the cache", async () => {
    const u = await makeUser(sql);
    await sql`
      insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at) values
        (${u.id}, 'stale', '2026-10-12T10:00Z', '2026-10-12T11:00Z'),
        (${u.id}, 'far-future', '2027-03-01T10:00Z', '2027-03-01T11:00Z')
    `;
    mock.on("GET", INITIAL, json(200, { value: [ev("e1", "2026-10-11T14:00:00", "2026-10-11T15:00:00")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=p2" }));
    mock.on("GET", /\$skiptoken=p2$/, json(200, { value: [ev("e2", "2026-10-13T09:00:00", "2026-10-13T09:30:00", { showAs: "tentative" })], "@odata.deltaLink": LINK_1 }));

    const report = await syncDelta(u.id, NOW);
    expect(report).toMatchObject({ mode: "full", upserted: 2, deleted: 1, conflicts: [] });
    expect((await blocks(u.id)).map((b) => [b.graph_event_id, b.show_as])).toEqual([
      ["e1", "busy"],
      ["e2", "tentative"],
      ["far-future", "busy"],
    ]);

    const first = mock.calls[0];
    expect(first.headers.prefer).toContain('outlook.timezone="UTC"');
    expect(decodeURIComponent(first.url)).toContain("startDateTime=2026-10-09T00:00:00Z&endDateTime=2026-12-09T00:00:00Z");

    const [cc] = await sql`select delta_link_enc, delta_window_start, last_synced_at from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.delta_link_enc).not.toContain("token-one");
    expect(decryptSecret(cc.delta_link_enc, u.id)).toBe(LINK_1);
    expect(cc.delta_window_start.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(cc.last_synced_at).not.toBeNull();
  });

  it("applies incremental updates and removals from the stored delta link", async () => {
    const u = await makeUser(sql);
    await sql`
      insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at) values
        (${u.id}, 'e1', '2026-10-11T14:00Z', '2026-10-11T15:00Z'),
        (${u.id}, 'e2', '2026-10-13T09:00Z', '2026-10-13T09:30Z')
    `;
    await withDeltaState(u.id);
    mock.on("GET", LINK_1_RE, json(200, {
      value: [ev("e1", "2026-10-11T16:00:00", "2026-10-11T17:00:00"), removed("e2"), ev("e3", "2026-10-14T09:00:00", "2026-10-14T10:00:00", { isCancelled: true })],
      "@odata.deltaLink": LINK_2,
    }));
    const report = await syncDelta(u.id, NOW);
    expect(report.mode).toBe("incremental");
    expect(mock.calls).toHaveLength(1);
    const rows = await blocks(u.id);
    expect(rows.map((r) => r.graph_event_id)).toEqual(["e1"]);
    expect(rows[0].start_at.toISOString()).toBe("2026-10-11T16:00:00.000Z");
    const [cc] = await sql`select delta_link_enc from app.calendar_connections where user_id = ${u.id}`;
    expect(decryptSecret(cc.delta_link_enc, u.id)).toBe(LINK_2);
  });

  it("falls back to a full resync on 410 Gone and on syncStateNotFound", async () => {
    for (const failure of [graphError(410, "Gone"), graphError(400, "syncStateNotFound")]) {
      await truncateAll(sql);
      mock = installGraphMock();
      const u = await makeUser(sql);
      await sql`insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at) values (${u.id}, 'stale', '2026-10-12T10:00Z', '2026-10-12T11:00Z')`;
      await withDeltaState(u.id);
      mock.on("GET", LINK_1_RE, failure);
      mock.on("GET", INITIAL, json(200, { value: [ev("fresh", "2026-10-15T10:00:00", "2026-10-15T11:00:00")], "@odata.deltaLink": LINK_2 }));
      const report = await syncDelta(u.id, NOW);
      expect(report.mode).toBe("full");
      expect((await blocks(u.id)).map((b) => b.graph_event_id)).toEqual(["fresh"]);
    }
  });

  it("starts a full round when the rolling window has moved", async () => {
    const u = await makeUser(sql);
    await withDeltaState(u.id);
    mock.on("GET", INITIAL, json(200, { value: [], "@odata.deltaLink": LINK_2 }));
    const report = await syncDelta(u.id, new Date("2026-10-11T08:00:00Z"));
    expect(report.mode).toBe("full");
    expect(mock.callsTo("GET", LINK_1_RE)).toHaveLength(0);
  });

  it("does not retry other 4xx errors as a resync", async () => {
    const u = await makeUser(sql);
    await withDeltaState(u.id);
    mock.on("GET", LINK_1_RE, graphError(403, "ErrorAccessDenied"));
    await expect(syncDelta(u.id, NOW)).rejects.toThrow(/403/);
    expect(mock.callsTo("GET", INITIAL)).toHaveLength(0);
  });
});

describe("Outlook-side changes to the app's own events", () => {
  const start = new Date("2026-10-20T15:00:00Z");
  const end = new Date("2026-10-20T15:30:00Z");

  it("auto_cancel: a deleted own event cancels the booking and notifies the invitee", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id, { policy: "auto_cancel" });
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, hosts: [{ userId: host.id, graphEventId: "own-1" }] });
    await withDeltaState(host.id);
    mock.on("GET", LINK_1_RE, json(200, { value: [removed("own-1")], "@odata.deltaLink": LINK_2 }));

    const report = await syncDelta(host.id, NOW);
    expect(report.conflicts).toEqual([{ bookingId, kind: "deleted", policy: "auto_cancel" }]);
    const [b] = await sql`select status, cancelled_by, cancelled_at, cancel_reason from app.bookings where id = ${bookingId}`;
    expect(b).toMatchObject({ status: "cancelled", cancelled_by: "host" });
    expect(b.cancelled_at).not.toBeNull();
    const [bh] = await sql`select active from app.booking_hosts where booking_id = ${bookingId}`;
    expect(bh.active).toBe(false);
    const jobs = await sql`select kind, payload from app.jobs order by kind`;
    expect(jobs).toEqual([{ kind: "email_send", payload: { template: "booking_cancelled", bookingId, recipient: "invitee" } }]);
    expect(await sql`select action from app.audit_log where entity_id = ${bookingId}`).toEqual([{ action: "booking.outlook_conflict_cancelled" }]);

    // A replay of the same change does nothing more.
    await withDeltaState(host.id);
    mock = installGraphMock();
    mock.on("GET", LINK_1_RE, json(200, { value: [removed("own-1")], "@odata.deltaLink": LINK_2 }));
    expect((await syncDelta(host.id, NOW)).conflicts).toEqual([]);
  });

  it("flag (team policy): a moved own event flags the booking and notifies the primary host", async () => {
    const host = await makeUser(sql);
    const co = await makeUser(sql);
    const { eventTypeId } = await makeTeamEventType(sql, { policy: "flag", mode: "collective" });
    const bookingId = await makeBooking(sql, {
      eventTypeId,
      start,
      end,
      hosts: [{ userId: host.id, role: "primary", graphEventId: "own-2" }, { userId: co.id, role: "collective" }],
    });
    await withDeltaState(host.id);
    mock.on("GET", LINK_1_RE, json(200, { value: [ev("own-2", "2026-10-20T17:00:00", "2026-10-20T17:30:00")], "@odata.deltaLink": LINK_2 }));

    const report = await syncDelta(host.id, NOW);
    expect(report.conflicts).toEqual([{ bookingId, kind: "moved", policy: "flag" }]);
    const [b] = await sql`select status, flagged_reason from app.bookings where id = ${bookingId}`;
    expect(b.status).toBe("flagged");
    expect(b.flagged_reason).toMatch(/moved/);
    const [bh] = await sql`select active from app.booking_hosts where booking_id = ${bookingId} and user_id = ${host.id}`;
    expect(bh.active).toBe(true);
    const jobs = await sql`select kind, payload from app.jobs`;
    expect(jobs).toEqual([{ kind: "email_send", payload: { template: "host_conflict_flagged", bookingId, recipient: { userId: host.id } } }]);
    expect((await blocks(host.id))[0].booking_id).toBe(bookingId);
  });

  it("auto_cancel on a moved event also cancels the Outlook event", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id, { policy: "auto_cancel" });
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, hosts: [{ userId: host.id, graphEventId: "own-3" }] });
    await withDeltaState(host.id);
    mock.on("GET", LINK_1_RE, json(200, { value: [ev("own-3", "2026-10-21T15:00:00", "2026-10-21T15:30:00")], "@odata.deltaLink": LINK_2 }));
    await syncDelta(host.id, NOW);
    const kinds = (await sql`select kind from app.jobs order by kind`).map((j) => j.kind);
    expect(kinds).toEqual(["email_send", "graph_event_delete"]);
    const [b] = await sql`select status from app.bookings where id = ${bookingId}`;
    expect(b.status).toBe("cancelled");
  });

  it("ignores changes the app made itself", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id, { policy: "auto_cancel" });
    // 1. Cancelled by the app: the Outlook deletion is expected.
    const cancelled = await makeBooking(sql, { eventTypeId: et, start, end, status: "cancelled", hosts: [{ userId: host.id, graphEventId: "own-c" }] });
    // 2. Rescheduled by the app, Outlook update still queued: the old time is expected.
    const s2 = new Date("2026-10-22T15:00:00Z");
    const rescheduled = await makeBooking(sql, { eventTypeId: et, start: s2, end: new Date("2026-10-22T15:30:00Z"), hosts: [{ userId: host.id, graphEventId: "own-r" }] });
    await enqueue(sql, { kind: "graph_event_upsert", payload: { bookingId: rescheduled }, idempotencyKey: "pending-upsert", bookingId: rescheduled });
    // 3. Our own write echoed back with the booking's times.
    const s3 = new Date("2026-10-23T15:00:00Z");
    const echoed = await makeBooking(sql, { eventTypeId: et, start: s3, end: new Date("2026-10-23T15:30:00Z"), hosts: [{ userId: host.id, graphEventId: "own-e" }] });

    await withDeltaState(host.id);
    mock.on("GET", LINK_1_RE, json(200, {
      value: [removed("own-c"), ev("own-r", "2026-10-20T15:00:00", "2026-10-20T15:30:00"), ev("own-e", "2026-10-23T15:00:00", "2026-10-23T15:30:00")],
      "@odata.deltaLink": LINK_2,
    }));
    const report = await syncDelta(host.id, NOW);
    expect(report.conflicts).toEqual([]);
    const statuses = await sql`select id, status from app.bookings where id in (${cancelled}, ${rescheduled}, ${echoed})`;
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [cancelled]: "cancelled",
      [rescheduled]: "confirmed",
      [echoed]: "confirmed",
    });
  });

  it("a full resync detects own events that disappeared while changes were not tracked", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id, { policy: "flag" });
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, hosts: [{ userId: host.id, graphEventId: "own-gone" }] });
    mock.on("GET", INITIAL, json(200, { value: [ev("other", "2026-10-15T10:00:00", "2026-10-15T11:00:00")], "@odata.deltaLink": LINK_2 }));
    const report = await syncDelta(host.id, NOW);
    expect(report.conflicts).toEqual([{ bookingId, kind: "deleted", policy: "flag" }]);
  });
});

describe("calendarView window sync", () => {
  it("upserts events, tags own events via the extended property, and deletes missing rows", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id);
    const bookingId = await makeBooking(sql, { eventTypeId: et, start: new Date("2026-10-20T15:00:00Z"), end: new Date("2026-10-20T15:30:00Z"), hosts: [{ userId: host.id }] });
    await sql`insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at) values (${host.id}, 'gone', '2026-10-19T10:00Z', '2026-10-19T11:00Z')`;
    mock.on("GET", /\/me\/calendarView\?/, json(200, {
      value: [
        ev("mine", "2026-10-20T15:00:00", "2026-10-20T15:30:00", { singleValueExtendedProperties: [{ id: BOOKING_PROP_ID, value: bookingId }] }),
        ev("allday", "2026-10-21T00:00:00", "2026-10-22T00:00:00", { isAllDay: true, showAs: "oof" }),
      ],
    }));
    const res = await syncCalendarWindow(host.id, new Date("2026-10-18T00:00:00Z"), new Date("2026-10-25T00:00:00Z"));
    expect(res).toEqual({ upserted: 2, deleted: 1 });
    const rows = await blocks(host.id);
    expect(rows.map((r) => [r.graph_event_id, r.booking_id])).toEqual([
      ["allday", null],
      ["mine", bookingId],
    ]);
    const url = decodeURIComponent(mock.calls[0].url);
    expect(url).toContain(`$expand=singleValueExtendedProperties($filter=id eq '${BOOKING_PROP_ID}')`);
  });
});

describe("liveFreeBusy", () => {
  it("uses getSchedule per host and falls back to the cache on error or timeout", async () => {
    const live = await makeUser(sql, { email: "live@bigthinkcapital.com" });
    const failing = await makeUser(sql, { email: "failing@bigthinkcapital.com" });
    const slow = await makeUser(sql, { email: "slow@bigthinkcapital.com" });
    for (const u of [failing, slow]) {
      await sql`insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at, show_as) values (${u.id}, 'cached', '2026-10-20T14:00Z', '2026-10-20T15:00Z', 'busy')`;
    }
    mock.on("POST", /\/me\/calendar\/getSchedule$/, (call) => {
      const email = (call.body as { schedules: string[] }).schedules[0];
      if (email === "failing@bigthinkcapital.com") return graphError(500, "InternalServerError");
      if (email === "slow@bigthinkcapital.com") return new Promise<Response>((r) => setTimeout(() => r(json(200, { value: [] })), 1500));
      return json(200, {
        value: [{
          scheduleId: email,
          availabilityView: "0220",
          scheduleItems: [
            { status: "busy", start: { dateTime: "2026-10-20T13:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T14:00:00.0000000", timeZone: "UTC" } },
            { status: "free", start: { dateTime: "2026-10-20T15:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-20T16:00:00.0000000", timeZone: "UTC" } },
          ],
        }],
      });
    });

    const from = new Date("2026-10-20T12:00:00Z");
    const to = new Date("2026-10-20T18:00:00Z");
    const t0 = Date.now();
    const res = await liveFreeBusyDetailed([live.id, failing.id, slow.id], from, to, 300);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.source).toEqual({ [live.id]: "live", [failing.id]: "cache", [slow.id]: "cache" });
    expect(res.blocks[live.id]).toEqual([{ start: Date.parse("2026-10-20T13:00:00Z"), end: Date.parse("2026-10-20T14:00:00Z"), showAs: "busy", isAllDay: false }]);
    expect(res.blocks[failing.id]).toEqual([{ start: Date.parse("2026-10-20T14:00:00Z"), end: Date.parse("2026-10-20T15:00:00Z"), showAs: "busy", isAllDay: false }]);

    const body = mock.callsTo("POST", /getSchedule/)[0].body as Record<string, unknown>;
    expect(body.startTime).toEqual({ dateTime: "2026-10-20T12:00:00", timeZone: "UTC" });
  });
});
