import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { graphError, installGraphMock, json, resetGraph, type GraphMock } from "../helpers/graph-mock";
import { makeBooking, makeIndividualEventType, makeTeamEventType } from "../helpers/booking-fixtures";
import type { Sql } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { runJobs } from "@/server/jobs/worker";
import { graphHandlers } from "@/server/graph/jobs";
import { BOOKING_PROP_ID } from "@/server/graph/client";
import type { EventPayload } from "@/server/graph/event-payload";

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

const start = new Date("2026-10-20T15:00:00Z");
const end = new Date("2026-10-20T15:30:00Z");
const JOIN = "https://teams.microsoft.com/l/meetup-join/abc";

async function run(kind: string, payload: Record<string, unknown>, key: string) {
  await enqueue(sql, { kind, payload, idempotencyKey: key });
  await runJobs(graphHandlers, { sql, deadlineMs: 5000 });
  const [job] = await sql`select status, last_error, result, attempts from app.jobs where kind = ${kind} and idempotency_key = ${key}`;
  return job;
}

describe("graph_event_upsert", () => {
  it("creates a Teams event on the primary host's calendar with the expected payload", async () => {
    const host = await makeUser(sql, { name: "Hana Host" });
    const co = await makeUser(sql, { name: "Cole Cohost", email: "cole@bigthinkcapital.com" });
    const { eventTypeId } = await makeTeamEventType(sql, { name: "Strategy Session", mode: "collective" });
    const bookingId = await makeBooking(sql, {
      eventTypeId,
      start,
      end,
      inviteeName: "Jane <Invitee>",
      hosts: [{ userId: host.id, role: "primary" }, { userId: co.id, role: "collective" }],
    });
    await sql`insert into app.booking_answers (booking_id, question_key, value) values (${bookingId}, 'company', 'Acme & Co')`;

    mock.on("GET", /\/me\/events\?/, json(200, { value: [] }));
    mock.on("POST", /\/me\/events$/, json(201, { id: "evt-1", iCalUId: "ical-1", onlineMeeting: { joinUrl: JOIN } }));

    const job = await run("graph_event_upsert", { bookingId }, "u1");
    expect(job.status).toBe("succeeded");

    const [post] = mock.callsTo("POST", /\/me\/events$/);
    const body = post.body as EventPayload;
    expect(body.subject).toBe("Strategy Session: Jane <Invitee>");
    expect(body.start).toEqual({ dateTime: "2026-10-20T15:00:00", timeZone: "UTC" });
    expect(body.end).toEqual({ dateTime: "2026-10-20T15:30:00", timeZone: "UTC" });
    expect(body.isOnlineMeeting).toBe(true);
    expect(body.onlineMeetingProvider).toBe("teamsForBusiness");
    expect(body.transactionId).toBe(bookingId);
    expect(body.singleValueExtendedProperties).toEqual([
      { id: "String {66f5a359-4659-4638-81a3-d1d2b2f5c5b4} Name BtcBookingId", value: bookingId },
    ]);
    expect(body.attendees).toEqual([
      { emailAddress: { address: "jane@example.com", name: "Jane <Invitee>" }, type: "required" },
      { emailAddress: { address: "cole@bigthinkcapital.com", name: "Cole Cohost" }, type: "required" },
    ]);
    expect(body.body.contentType).toBe("HTML");
    expect(body.body.content).toContain("Jane &lt;Invitee&gt;");
    expect(body.body.content).toContain("Acme &amp; Co");
    expect(body.body.content).not.toContain("<Invitee>");

    const hosts = await sql`select user_id, graph_event_id, ical_uid from app.booking_hosts where booking_id = ${bookingId} order by role`;
    expect(hosts.find((h) => h.user_id === host.id)).toMatchObject({ graph_event_id: "evt-1", ical_uid: "ical-1" });
    expect(hosts.find((h) => h.user_id === co.id)).toMatchObject({ graph_event_id: null, ical_uid: "ical-1" });
    const [b] = await sql`select online_meeting_url from app.bookings where id = ${bookingId}`;
    expect(b.online_meeting_url).toBe(JOIN);
  });

  it("uses a phone location and no online meeting fields for phone events", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id, { locationType: "phone" });
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, locationType: "phone", inviteePhone: "+1 555 0100", hosts: [{ userId: host.id }] });
    mock.on("GET", /\/me\/events\?/, json(200, { value: [] }));
    mock.on("POST", /\/me\/events$/, json(201, { id: "evt-p", iCalUId: "ical-p" }));
    expect((await run("graph_event_upsert", { bookingId }, "p1")).status).toBe("succeeded");
    const body = mock.callsTo("POST", /\/me\/events$/)[0].body as EventPayload;
    expect(body.location).toEqual({ displayName: "Phone: +1 555 0100" });
    expect(body.isOnlineMeeting).toBeUndefined();
    expect(body.attendees).toHaveLength(1);
  });

  it("is idempotent: an event created by a failed attempt is found by its tag and updated", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id);
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, hosts: [{ userId: host.id }] });

    // First attempt: the event is created, then the response is lost (503s exhaust retries).
    mock.on("GET", /\/me\/events\?/, json(200, { value: [] }));
    mock.on("POST", /\/me\/events$/, graphError(503, "ServiceUnavailable"));
    let job = await run("graph_event_upsert", { bookingId }, "i1");
    expect(job.status).toBe("failed");

    // Retry: the tag search now finds the event, so the job PATCHes it instead of creating another.
    mock = installGraphMock();
    mock.on("GET", /\/me\/events\?/, json(200, { value: [{ id: "evt-9", iCalUId: "ical-9", onlineMeeting: { joinUrl: JOIN } }] }));
    mock.on("PATCH", /\/me\/events\/evt-9$/, json(200, { id: "evt-9", iCalUId: "ical-9", onlineMeeting: { joinUrl: JOIN } }));
    await sql`update app.jobs set run_at = now() where idempotency_key = 'i1'`;
    await runJobs(graphHandlers, { sql, deadlineMs: 5000 });
    [job] = await sql`select status from app.jobs where idempotency_key = 'i1'`;
    expect(job.status).toBe("succeeded");
    expect(mock.callsTo("POST", /\/me\/events$/)).toHaveLength(0);
    const search = mock.callsTo("GET", /\/me\/events\?/)[0];
    expect(decodeURIComponent(search.url)).toContain(`ep/id eq '${BOOKING_PROP_ID}' and ep/value eq '${bookingId}'`);
    const patch = mock.callsTo("PATCH", /evt-9/)[0].body as Record<string, unknown>;
    expect(patch.onlineMeetingProvider).toBeUndefined();
    expect(patch.transactionId).toBeUndefined();

    // Running again with the stored id goes straight to PATCH.
    mock = installGraphMock();
    mock.on("PATCH", /\/me\/events\/evt-9$/, json(200, { id: "evt-9", iCalUId: "ical-9", onlineMeeting: { joinUrl: JOIN } }));
    expect((await run("graph_event_upsert", { bookingId }, "i2")).status).toBe("succeeded");
    expect(mock.calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("skips cancelled bookings and fails permanently for broken connections", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id);
    const cancelled = await makeBooking(sql, { eventTypeId: et, start, end, status: "cancelled", hosts: [{ userId: host.id }] });
    expect((await run("graph_event_upsert", { bookingId: cancelled }, "c1")).status).toBe("succeeded");
    expect(mock.calls).toHaveLength(0);

    // Use the real token path: a broken connection must not be retried.
    resetGraph();
    const broken = await makeUser(sql, { calendar: "broken" });
    const et2 = await makeIndividualEventType(sql, broken.id);
    const b2 = await makeBooking(sql, { eventTypeId: et2, start: new Date("2026-10-21T15:00:00Z"), end: new Date("2026-10-21T15:30:00Z"), hosts: [{ userId: broken.id }] });
    const job = await run("graph_event_upsert", { bookingId: b2 }, "c2");
    expect(job.status).toBe("dead");
    expect(job.last_error).toMatch(/reconnect Outlook/);
    expect(job.attempts).toBe(1);
  });

  it("treats 4xx validation errors as permanent", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id);
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, hosts: [{ userId: host.id }] });
    mock.on("GET", /\/me\/events\?/, json(200, { value: [] }));
    mock.on("POST", /\/me\/events$/, graphError(400, "ErrorInvalidRequest"));
    const job = await run("graph_event_upsert", { bookingId }, "v1");
    expect(job.status).toBe("dead");
    expect(job.result).toMatchObject({ status: 400, code: "ErrorInvalidRequest" });
  });
});

describe("graph_event_delete", () => {
  it("deletes the event, treats 404 as success, and drops the cached block", async () => {
    const host = await makeUser(sql);
    const et = await makeIndividualEventType(sql, host.id);
    const bookingId = await makeBooking(sql, { eventTypeId: et, start, end, status: "cancelled", hosts: [{ userId: host.id, graphEventId: "evt-d" }] });
    await sql`insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at) values (${host.id}, 'evt-d', ${start}, ${end})`;

    mock.on("DELETE", /\/me\/events\/evt-d$/, new Response(null, { status: 204 }));
    expect((await run("graph_event_delete", { bookingId, userId: host.id, graphEventId: null }, "d1")).status).toBe("succeeded");
    expect(await sql`select 1 from app.busy_blocks where graph_event_id = 'evt-d'`).toHaveLength(0);

    mock = installGraphMock();
    mock.on("DELETE", /\/me\/events\/evt-d$/, graphError(404, "ErrorItemNotFound"));
    const job = await run("graph_event_delete", { bookingId, userId: host.id, graphEventId: "evt-d" }, "d2");
    expect(job.status).toBe("succeeded");
    expect(job.result).toEqual({ deleted: false });
  });
});
