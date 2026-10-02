import { describe, expect, it } from "vitest";
import { graphQuery, GraphError, parseRetryAfter } from "@/server/graph/client";
import { parseEvent, parseGraphDateTime, taggedBookingId } from "@/server/graph/busy";
import { deltaWindow, isResyncError } from "@/server/graph/delta";
import { buildCreatePayload, buildUpdatePayload, escapeHtml, type EventPayload, type EventPayloadInput } from "@/server/graph/event-payload";
import { deltaBucket } from "@/server/graph/subscriptions";

const BOOKING = "3f1c2b8e-5d4a-4c1b-9e7f-0a1b2c3d4e5f";

describe("parseRetryAfter", () => {
  it("reads delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Fri, 02 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });
});

describe("graphQuery", () => {
  it("encodes spaces as %20 and keeps OData $ prefixes", () => {
    expect(graphQuery({ $filter: "a eq 'b c'", $top: "1" })).toBe("$filter=a%20eq%20'b%20c'&$top=1");
  });
});

describe("event parsing", () => {
  it("parses Graph dateTimeTimeZone values in UTC and Windows zones", () => {
    expect(parseGraphDateTime({ dateTime: "2026-10-20T15:00:00.0000000", timeZone: "UTC" })?.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(parseGraphDateTime({ dateTime: "2026-10-20T10:00:00.0000000", timeZone: "Eastern Standard Time" })?.toISOString()).toBe(
      "2026-10-20T14:00:00.000Z",
    );
    expect(parseGraphDateTime(null)).toBeNull();
  });

  it("treats removed and cancelled events as absent", () => {
    const base = { id: "e", start: { dateTime: "2026-10-20T15:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-20T16:00:00", timeZone: "UTC" } };
    expect(parseEvent(base)).toMatchObject({ graphEventId: "e", showAs: "busy", isAllDay: false });
    expect(parseEvent({ ...base, isCancelled: true })).toBeNull();
    expect(parseEvent({ id: "e", "@removed": { reason: "deleted" } })).toBeNull();
    expect(parseEvent({ ...base, end: base.start })).toBeNull();
  });

  it("reads the booking tag from the extended property or transactionId", () => {
    const prop = "String {66f5a359-4659-4638-81a3-d1d2b2f5c5b4} Name BtcBookingId";
    expect(taggedBookingId({ id: "e", singleValueExtendedProperties: [{ id: prop, value: BOOKING }] })).toBe(BOOKING);
    expect(taggedBookingId({ id: "e", transactionId: BOOKING.toUpperCase() })).toBe(BOOKING);
    expect(taggedBookingId({ id: "e", transactionId: "not-a-uuid" })).toBeNull();
  });
});

describe("delta helpers", () => {
  it("computes the rolling window from the UTC day", () => {
    const w = deltaWindow(new Date("2026-10-10T23:59:00Z"));
    expect(w.start.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-12-09T00:00:00.000Z");
  });

  it("recognizes resync errors", () => {
    expect(isResyncError(new GraphError("x", 410, null))).toBe(true);
    expect(isResyncError(new GraphError("x", 400, "syncStateNotFound"))).toBe(true);
    expect(isResyncError(new GraphError("x", 400, "ErrorInvalidRequest"))).toBe(false);
    expect(isResyncError(new GraphError("x", 503, "syncStateNotFound"))).toBe(false);
    expect(isResyncError(new Error("x"))).toBe(false);
  });

  it("buckets delta jobs per 30 seconds", () => {
    expect(deltaBucket(60_000)).toBe(2);
    expect(deltaBucket(89_999)).toBe(2);
    expect(deltaBucket(90_000)).toBe(3);
  });
});

describe("event payload", () => {
  const input: EventPayloadInput = {
    bookingId: BOOKING,
    eventTypeName: "Intro",
    startAt: new Date("2026-10-20T15:00:00Z"),
    endAt: new Date("2026-10-20T15:30:00Z"),
    invitee: { name: "Ann", email: "ann@example.com", phone: null, timezone: "America/Chicago" },
    locationType: "teams",
    locationDetail: null,
    coHosts: [],
    answers: [{ label: "Notes", value: "<script>alert(1)</script>" }],
  };

  it("builds a Teams create payload with the booking tag and transactionId", () => {
    const p = buildCreatePayload(input) as EventPayload;
    expect(p.subject).toBe("Intro: Ann");
    expect(p.isOnlineMeeting).toBe(true);
    expect(p.onlineMeetingProvider).toBe("teamsForBusiness");
    expect(p.transactionId).toBe(BOOKING);
    expect(p.singleValueExtendedProperties[0].value).toBe(BOOKING);
    expect(p.body.content).not.toContain("<script>");
    expect(p.body.content).toContain("&lt;script&gt;");
  });

  it("omits fields Graph will not change on update", () => {
    const p = buildUpdatePayload(input);
    expect(p).not.toHaveProperty("onlineMeetingProvider");
    expect(p).not.toHaveProperty("transactionId");
    expect(buildCreatePayload({ ...input, locationType: "in_person", locationDetail: "HQ" })).toMatchObject({ location: { displayName: "HQ" } });
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
