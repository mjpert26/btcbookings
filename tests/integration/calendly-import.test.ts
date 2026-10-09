import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { importCalendly } from "@/server/import/calendly/run";
import { snapshotSchema, type CalendlySnapshot } from "@/server/import/calendly/map";
import { enqueue } from "@/server/jobs/queue";
import { cancelBookingAsHost } from "@/server/booking/host-actions";

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
});

const U = (id: string) => `https://api.calendly.com/users/${id}`;
const ET = (id: string) => `https://api.calendly.com/event_types/${id}`;
const EV = (id: string) => `https://api.calendly.com/scheduled_events/${id}`;
const TEAM = "https://api.calendly.com/groups/team-ripe";
const NOW = new Date("2026-10-09T12:00:00Z");

function snapshot(over: Partial<CalendlySnapshot> = {}): CalendlySnapshot {
  return snapshotSchema.parse({
    source: "calendly",
    pulledAt: NOW.toISOString(),
    members: [
      { uri: U("a"), name: "Aidan Miller", email: "aidan.miller@bigthinkcapital.com", slug: "aidan-miller-bigthinkcapital", timezone: "America/New_York" },
      { uri: U("b"), name: "Jesse Axman", email: "jesse.axman@bigthinkcapital.com", slug: "jesse-axman-bigthinkcapital", timezone: "America/Chicago" },
    ],
    eventTypes: [
      {
        uri: ET("personal"),
        name: "Financing Intro Call",
        slug: "financing-intro-call",
        active: true,
        duration: 15,
        scheduling_url: "https://calendly.com/aidan-miller-bigthinkcapital/financing-intro-call",
        profile: { type: "User", name: "Aidan Miller", owner: U("a") },
        custom_questions: [
          { name: "Business name", type: "string", position: 0, enabled: true, required: true },
          { name: "Anything else?", type: "text", position: 1, enabled: true, required: false },
          { name: "Hidden", type: "string", position: 2, enabled: false, required: false },
        ],
        locations: [{ kind: "outbound_call" }],
      },
      {
        uri: ET("rr"),
        name: "15 Minute Financing Call",
        slug: "30-minute-financing-call",
        active: true,
        pooling_type: "round_robin",
        duration: 15,
        secret: true,
        scheduling_url: "https://calendly.com/ripe-funds/30-minute-financing-call",
        profile: { type: "Team", name: "Ripe Funds", owner: TEAM },
        locations: [{ kind: "microsoft_teams_conference" }],
        hosts: [U("a"), U("b")],
      },
      {
        uri: ET("inactive"),
        name: "Old Page",
        active: false,
        duration: 30,
        scheduling_url: "https://calendly.com/aidan-miller-bigthinkcapital/old",
        profile: { type: "User", name: "Aidan Miller", owner: U("a") },
      },
    ],
    events: [
      {
        uri: EV("1"),
        status: "active",
        start_time: "2026-10-12T14:00:00Z",
        end_time: "2026-10-12T14:15:00Z",
        event_type: ET("personal"),
        location: { type: "outbound_call", location: "+1 212 555 0100" },
        hosts: [U("a")],
        invitees: [
          {
            name: "Pat Customer",
            email: "Pat@Example.com",
            timezone: "America/New_York",
            questions_and_answers: [
              { question: "Business name", answer: "Pat's Pizza", position: 0 },
              { question: "Removed question", answer: "kept anyway", position: 3 },
            ],
          },
        ],
      },
      {
        uri: EV("2"),
        status: "active",
        start_time: "2026-10-13T15:00:00Z",
        end_time: "2026-10-13T15:15:00Z",
        event_type: ET("rr"),
        location: { type: "microsoft_teams_conference", join_url: "https://teams.microsoft.com/l/meetup-join/x" },
        hosts: [U("b")],
        invitees: [{ name: "Sam Lead", email: "sam@example.com" }],
      },
      {
        uri: EV("past"),
        status: "active",
        start_time: "2026-10-01T15:00:00Z",
        end_time: "2026-10-01T15:15:00Z",
        event_type: ET("personal"),
        hosts: [U("a")],
        invitees: [{ name: "Old", email: "old@example.com" }],
      },
    ],
    ...over,
  });
}

describe("Calendly import", () => {
  it("dry run reports changes without saving anything", async () => {
    const r = await importCalendly(snapshot(), { apply: false, actorUserId: null, now: NOW });
    expect(r.applied).toBe(false);
    expect(r.users.created).toBe(2);
    expect(r.eventTypes.created).toBe(2);
    expect(r.bookings.created).toBe(2);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.users`;
    expect(n).toBe(0);
  });

  it("imports users, teams, pages and upcoming bookings without creating any jobs", async () => {
    const existing = await makeUser(sql, { email: "jesse.axman@bigthinkcapital.com", name: "Jesse A" });
    const r = await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    expect(r.applied).toBe(true);
    expect(r.users).toEqual({ created: 1, existing: 1 });
    expect(r.teams.created).toBe(1);
    expect(r.teamMembers.added).toBe(2);
    expect(r.eventTypes).toEqual({ created: 2, existing: 0, skipped: 0 });
    expect(r.bookings.created).toBe(2);
    expect(r.bookings.skipped).toBe(1); // the past meeting

    const [aidan] = await sql<{ id: string; slug: string; entra_oid: string | null }[]>`
      select id, slug, entra_oid from app.users where email = 'aidan.miller@bigthinkcapital.com'`;
    expect(aidan.slug).toBe("aidan-miller");
    expect(aidan.entra_oid).toBeNull();
    const [{ n: schedules }] = await sql<{ n: number }[]>`select count(*)::int as n from app.availability_schedules where owner_user_id = ${aidan.id} and is_default`;
    expect(schedules).toBe(1);

    const [team] = await sql<{ id: string; slug: string }[]>`select id, slug from app.teams`;
    expect(team.slug).toBe("ripe-funds");

    const [personal] = await sql<{ id: string; slug: string; location_type: string; durations: number[] }[]>`
      select id, slug, location_type, durations from app.event_types where owner_user_id = ${aidan.id}`;
    expect(personal).toMatchObject({ slug: "financing-intro-call", location_type: "phone", durations: [15] });
    const qs = await sql<{ key: string; type: string; required: boolean }[]>`
      select key, type, required from app.event_type_questions where event_type_id = ${personal.id} order by position`;
    expect(qs).toEqual([
      { key: "phone", type: "phone", required: true },
      { key: "business_name", type: "text", required: true },
      { key: "anything_else", type: "textarea", required: false },
    ]);

    const [rr] = await sql<{ id: string; scheduling_mode: string; is_listed: boolean; slug: string }[]>`
      select id, scheduling_mode, is_listed, slug from app.event_types where team_id = ${team.id}`;
    expect(rr).toMatchObject({ scheduling_mode: "round_robin", is_listed: false, slug: "30-minute-financing-call" });
    const [{ n: hosts }] = await sql<{ n: number }[]>`select count(*)::int as n from app.event_type_hosts where event_type_id = ${rr.id}`;
    expect(hosts).toBe(2);

    const [b1] = await sql<{ id: string; invitee_email: string; invitee_phone: string; status: string; import_source: string }[]>`
      select id, invitee_email, invitee_phone, status, import_source from app.bookings where import_ref = ${EV("1")}`;
    expect(b1).toMatchObject({ invitee_email: "pat@example.com", invitee_phone: "+1 212 555 0100", status: "confirmed", import_source: "calendly" });
    const answers = await sql<{ question_key: string; value: string }[]>`
      select question_key, value from app.booking_answers where booking_id = ${b1.id} order by question_key`;
    expect(answers).toEqual([
      { question_key: "business_name", value: "Pat's Pizza" },
      { question_key: "calendly_q4", value: "kept anyway" },
    ]);

    const [b2] = await sql<{ id: string; online_meeting_url: string }[]>`select id, online_meeting_url from app.bookings where import_ref = ${EV("2")}`;
    expect(b2.online_meeting_url).toContain("teams.microsoft.com");
    const [host] = await sql<{ user_id: string; team_member_id: string | null; active: boolean }[]>`
      select user_id, team_member_id, active from app.booking_hosts where booking_id = ${b2.id}`;
    expect(host.user_id).toBe(existing.id);
    expect(host.team_member_id).not.toBeNull();
    expect(host.active).toBe(true);

    const [{ n: jobs }] = await sql<{ n: number }[]>`select count(*)::int as n from app.jobs`;
    expect(jobs).toBe(0);
  });

  it("drops any job enqueued for an imported booking and refuses host cancellation", async () => {
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    const [b] = await sql<{ id: string }[]>`select id from app.bookings where import_ref = ${EV("1")}`;
    const id = await enqueue(sql, { kind: "email_send", payload: { template: "booking_cancelled", bookingId: b.id, recipient: "invitee" }, bookingId: b.id });
    expect(id).toBeNull();
    await enqueue(sql, { kind: "graph_event_delete", payload: { bookingId: b.id, userId: b.id, graphEventId: null } });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.jobs`;
    expect(n).toBe(0);

    const admin = await makeUser(sql, { role: "admin" });
    const res = await cancelBookingAsHost(admin.id, b.id, null);
    expect(res).toEqual({ ok: false, reason: "imported" });
  });

  it("is idempotent and picks up Calendly cancellations and moves", async () => {
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    const again = await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    expect(again.users).toEqual({ created: 0, existing: 2 });
    expect(again.teams).toEqual({ created: 0, existing: 1 });
    expect(again.eventTypes).toEqual({ created: 0, existing: 2, skipped: 0 });
    expect(again.bookings.unchanged).toBe(2);

    const snap = snapshot();
    snap.events[0].status = "canceled";
    snap.events[1].start_time = "2026-10-13T16:00:00Z";
    snap.events[1].end_time = "2026-10-13T16:15:00Z";
    const third = await importCalendly(snap, { apply: true, actorUserId: null, now: NOW });
    expect(third.bookings.cancelled).toBe(1);
    expect(third.bookings.updated).toBe(1);
    const rows = await sql<{ import_ref: string; status: string; start_at: Date }[]>`
      select import_ref, status, start_at from app.bookings order by import_ref`;
    expect(rows[0]).toMatchObject({ import_ref: EV("1"), status: "cancelled" });
    expect(rows[1].start_at.toISOString()).toBe("2026-10-13T16:00:00.000Z");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.jobs`;
    expect(n).toBe(0);
  });

  it("copies overlapping meetings as flagged instead of failing", async () => {
    const snap = snapshot();
    snap.events.push({ ...snap.events[0], uri: EV("dup"), invitees: [{ ...snap.events[0].invitees[0], email: "other@example.com" }] });
    const r = await importCalendly(snap, { apply: true, actorUserId: null, now: NOW });
    expect(r.bookings.created).toBe(3);
    expect(r.bookings.flagged).toBe(1);
    const [dup] = await sql<{ status: string }[]>`select status from app.bookings where import_ref = ${EV("dup")}`;
    expect(dup.status).toBe("flagged");
  });
});
