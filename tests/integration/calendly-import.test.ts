import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { importCalendly, ImportRefusedError } from "@/server/import/calendly/run";
import { goLiveImportedPages, listImportedPages, pauseImportedPages, CutoverForbiddenError } from "@/server/import/calendly/cutover";
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

const weekdays = (from: string, to: string) =>
  ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((wday) => ({
    type: "wday",
    wday,
    intervals: wday === "sunday" || wday === "saturday" ? [] : [{ from, to }],
  }));

function snapshot(over: Partial<CalendlySnapshot> = {}): CalendlySnapshot {
  return snapshotSchema.parse({
    source: "calendly",
    pulledAt: NOW.toISOString(),
    eventsWindow: { from: "2026-09-01T00:00:00Z", to: "2027-01-01T00:00:00Z" },
    includesCanceled: true,
    members: [
      {
        uri: U("a"),
        name: "Aidan Miller",
        email: "aidan.miller@bigthinkcapital.com",
        slug: "aidan-miller-bigthinkcapital",
        timezone: "America/New_York",
        availability: { timezone: "America/New_York", rules: [...weekdays("09:45", "18:15"), { type: "date", date: "2026-11-26", intervals: [] }] },
      },
      { uri: U("b"), name: "Jesse Axman", email: "jesse.axman@bigthinkcapital.com", slug: "jesse-axman-bigthinkcapital", timezone: "America/Chicago" },
      { uri: U("c"), name: "Chris Stokum", email: "chris.stokum@bigthinkcapital.com", slug: "chris-stokum-bigthinkcapital" },
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
        hostsComplete: false,
      },
      {
        uri: ET("group"),
        name: "Group Session",
        kind: "group",
        active: true,
        duration: 30,
        scheduling_url: "https://calendly.com/aidan-miller-bigthinkcapital/group",
        profile: { type: "User", name: "Aidan Miller", owner: U("a") },
      },
      {
        uri: ET("nolocation"),
        name: "Quick Question (Español)",
        active: true,
        duration: 15,
        scheduling_url: "https://calendly.com/aidan-miller-bigthinkcapital/quick",
        profile: { type: "User", name: "Aidan Miller", owner: U("a") },
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
        buffered_start_time: "2026-10-12T14:00:00Z",
        buffered_end_time: "2026-10-12T14:30:00Z",
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
        // A host who takes meetings for the type but is missing from the truncated host list.
        uri: EV("3"),
        status: "active",
        start_time: "2026-10-14T15:00:00Z",
        end_time: "2026-10-14T15:15:00Z",
        event_type: ET("rr"),
        hosts: [U("c")],
        invitees: [{ name: "Alex Lead", email: "alex@example.com" }],
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

const count = async (q: PromiseLike<unknown>) => ((await q) as { n: number }[])[0].n;

describe("Calendly import", () => {
  it("dry run reports changes without saving anything", async () => {
    const r = await importCalendly(snapshot(), { apply: false, actorUserId: null, now: NOW });
    expect(r.applied).toBe(false);
    expect(r.users.created).toBe(3);
    expect(r.eventTypes.created).toBe(4);
    expect(r.bookings.created).toBe(3);
    expect(await count(sql`select count(*)::int as n from app.users`)).toBe(0);
  });

  it("refuses to apply a placeholder snapshot", async () => {
    await expect(importCalendly(snapshot({ placeholder: true }), { apply: true, actorUserId: null, now: NOW })).rejects.toBeInstanceOf(ImportRefusedError);
    const r = await importCalendly(snapshot({ placeholder: true }), { apply: false, actorUserId: null, now: NOW });
    expect(r.applied).toBe(false);
  });

  it("imports users with their hours, teams, dormant pages and upcoming bookings without creating any jobs", async () => {
    const existing = await makeUser(sql, { email: "jesse.axman@bigthinkcapital.com", name: "Jesse A" });
    const r = await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    expect(r.applied).toBe(true);
    expect(r.users).toEqual({ created: 2, existing: 1, schedulesImported: 1 });
    expect(r.teams.created).toBe(1);
    expect(r.teamMembers.added).toBe(3);
    expect(r.eventTypes).toEqual({ created: 4, existing: 0, skipped: 0, goLiveEligible: 3 });
    expect(r.bookings.created).toBe(3);
    expect(r.bookings.skipped).toBe(1); // the past meeting
    expect(r.warnings.some((w) => w.includes("group event"))).toBe(true);

    const [aidan] = await sql<{ id: string; slug: string; entra_oid: string | null }[]>`
      select id, slug, entra_oid from app.users where email = 'aidan.miller@bigthinkcapital.com'`;
    expect(aidan.slug).toBe("aidan-miller");
    expect(aidan.entra_oid).toBeNull();
    const [sched] = await sql<{ id: string; weekly_rules: Record<string, unknown>; timezone: string }[]>`
      select id, weekly_rules, timezone from app.availability_schedules where owner_user_id = ${aidan.id} and is_default`;
    expect(sched.weekly_rules.mon).toEqual([{ start: "09:45", end: "18:15" }]);
    expect(sched.weekly_rules.sun).toEqual([]);
    const overrides = await sql`select date::text as date, intervals from app.availability_overrides where schedule_id = ${sched.id}`;
    expect(overrides).toEqual([{ date: "2026-11-26", intervals: [] }]);
    const [chris] = await sql<{ id: string }[]>`select id from app.users where email = 'chris.stokum@bigthinkcapital.com'`;
    const [chrisSched] = await sql<{ weekly_rules: Record<string, unknown> }[]>`select weekly_rules from app.availability_schedules where owner_user_id = ${chris.id}`;
    expect(chrisSched.weekly_rules.mon).toEqual([{ start: "09:30", end: "18:30" }]); // table default without Calendly hours

    // Every imported page starts inactive; Calendly's flags are kept for go-live.
    const types = await sql<{ name: string; is_active: boolean; is_listed: boolean; import_meta: { active: boolean; kind: string }; location_type: string; location_detail: string | null; language: string }[]>`
      select name, is_active, is_listed, import_meta, location_type, location_detail, language from app.event_types order by name`;
    expect(types.every((t) => !t.is_active)).toBe(true);
    const group = types.find((t) => t.name === "Group Session")!;
    expect(group).toMatchObject({ is_listed: false, import_meta: { active: false, kind: "group" } });
    const es = types.find((t) => t.name.includes("Español"))!;
    expect(es).toMatchObject({ language: "es", location_type: "custom" });
    expect(es.location_detail).toContain("asesor");

    const [team] = await sql<{ id: string; slug: string }[]>`select id, slug from app.teams`;
    expect(team.slug).toBe("ripe-funds");

    const [personal] = await sql<{ id: string; slug: string; location_type: string; durations: number[] }[]>`
      select id, slug, location_type, durations from app.event_types where owner_user_id = ${aidan.id} and slug = 'financing-intro-call'`;
    expect(personal).toMatchObject({ location_type: "phone", durations: [15] });
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
    // Listed hosts plus the rep seen on its meetings, because the list may be truncated.
    expect(await count(sql`select count(*)::int as n from app.event_type_hosts where event_type_id = ${rr.id}`)).toBe(3);

    const [b1] = await sql<{ id: string; invitee_email: string; invitee_phone: string; status: string; import_source: string }[]>`
      select id, invitee_email, invitee_phone, status, import_source from app.bookings where import_ref = ${EV("1")}`;
    expect(b1).toMatchObject({ invitee_email: "pat@example.com", invitee_phone: "+1 212 555 0100", status: "confirmed", import_source: "calendly" });
    const [hold] = await sql<{ r: string }[]>`select blocked_range::text as r from app.booking_hosts where booking_id = ${b1.id}`;
    expect(hold.r).toContain("14:30:00"); // Calendly's 15-minute buffer after the meeting
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
    expect(host).toMatchObject({ user_id: existing.id, active: true });
    expect(host.team_member_id).not.toBeNull();

    expect(await count(sql`select count(*)::int as n from app.jobs`)).toBe(0);
  });

  it("takes pages live and pauses them only through the admin cutover, with an audit trail", async () => {
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    const admin = await makeUser(sql, { role: "admin" });
    const rep = await makeUser(sql, { role: "user" });
    await expect(goLiveImportedPages(rep, { kind: "all" })).rejects.toBeInstanceOf(CutoverForbiddenError);

    const rows = await listImportedPages(admin);
    const team = rows.find((r) => r.kind === "team")!;
    expect(team).toMatchObject({ name: "Ripe Funds", ready: 1, live: 0, hosts: 3 });
    const aidan = rows.find((r) => r.kind === "user" && r.name === "Aidan Miller")!;
    expect(aidan).toMatchObject({ ready: 2, live: 0, connected: 0 });

    expect(await goLiveImportedPages(admin, { kind: "team", teamId: team.id })).toBe(1);
    expect(await goLiveImportedPages(admin, { kind: "all" })).toBe(2); // the group page and the inactive page stay off
    const active = await sql<{ name: string }[]>`select name from app.event_types where is_active order by name`;
    expect(active.map((r) => r.name)).toEqual(["15 Minute Financing Call", "Financing Intro Call", "Quick Question (Español)"]);

    expect(await pauseImportedPages(admin, { kind: "user", userId: aidan.id })).toBe(2);
    expect(await count(sql`select count(*)::int as n from app.event_types where is_active`)).toBe(1);
    const audit = await sql<{ action: string }[]>`select action from app.audit_log where action like 'import.calendly.%' order by created_at`;
    expect(audit.map((a) => a.action)).toEqual(["import.calendly.go_live", "import.calendly.go_live", "import.calendly.pause"]);

    // A re-run never reactivates or deactivates anything.
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    expect(await count(sql`select count(*)::int as n from app.event_types where is_active`)).toBe(1);
  });

  it("drops any job enqueued for an imported booking and refuses host cancellation", async () => {
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    const [b] = await sql<{ id: string }[]>`select id from app.bookings where import_ref = ${EV("1")}`;
    const id = await enqueue(sql, { kind: "email_send", payload: { template: "booking_cancelled", bookingId: b.id, recipient: "invitee" }, bookingId: b.id });
    expect(id).toBeNull();
    await enqueue(sql, { kind: "graph_event_delete", payload: { bookingId: b.id, userId: b.id, graphEventId: null } });
    expect(await count(sql`select count(*)::int as n from app.jobs`)).toBe(0);

    const admin = await makeUser(sql, { role: "admin" });
    const res = await cancelBookingAsHost(admin.id, b.id, null);
    expect(res).toEqual({ ok: false, reason: "imported" });
  });

  it("is idempotent and picks up Calendly cancellations, moves, reassignments and missing meetings", async () => {
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    const again = await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    expect(again.users).toEqual({ created: 0, existing: 3, schedulesImported: 0 });
    expect(again.teams).toEqual({ created: 0, existing: 1 });
    expect(again.eventTypes).toEqual({ created: 0, existing: 4, skipped: 0, goLiveEligible: 0 });
    expect(again.bookings.unchanged).toBe(3);

    const snap = snapshot();
    snap.events[0].status = "canceled";
    snap.events[0].invitees = []; // a cancellation needs no invitee
    snap.events[1].start_time = "2026-10-13T16:00:00Z";
    snap.events[1].end_time = "2026-10-13T16:15:00Z";
    snap.events[1].hosts = [U("a")];
    snap.events.splice(2, 1); // EV("3") is no longer listed in Calendly
    const third = await importCalendly(snap, { apply: true, actorUserId: null, now: NOW });
    expect(third.bookings).toMatchObject({ cancelled: 1, updated: 1, reassigned: 1, cancelledMissing: 1 });

    const rows = await sql<{ import_ref: string; status: string; start_at: Date; cancel_reason: string | null }[]>`
      select import_ref, status, start_at, cancel_reason from app.bookings order by import_ref`;
    expect(rows[0]).toMatchObject({ import_ref: EV("1"), status: "cancelled", cancel_reason: "Cancelled in Calendly" });
    expect(rows[1].start_at.toISOString()).toBe("2026-10-13T16:00:00.000Z");
    expect(rows[2]).toMatchObject({ import_ref: EV("3"), status: "cancelled", cancel_reason: "No longer listed in Calendly" });
    const [aidan] = await sql<{ id: string }[]>`select id from app.users where email = 'aidan.miller@bigthinkcapital.com'`;
    const [h] = await sql<{ user_id: string; active: boolean }[]>`
      select bh.user_id, bh.active from app.booking_hosts bh join app.bookings b on b.id = bh.booking_id where b.import_ref = ${EV("2")}`;
    expect(h).toMatchObject({ user_id: aidan.id, active: true });
    expect(await count(sql`select count(*)::int as n from app.booking_hosts where active and booking_id in (select id from app.bookings where status = 'cancelled')`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from app.jobs`)).toBe(0);
  });

  it("does not re-add team members an admin removed", async () => {
    await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    await sql`delete from app.team_members where email = 'chris.stokum@bigthinkcapital.com'`;
    const r = await importCalendly(snapshot(), { apply: true, actorUserId: null, now: NOW });
    expect(r.teamMembers.added).toBe(0);
    expect(r.warnings.some((w) => w.includes("not re-added"))).toBe(true);
    expect(await count(sql`select count(*)::int as n from app.team_members`)).toBe(2);
  });

  it("copies overlapping meetings as flagged instead of failing", async () => {
    const snap = snapshot();
    snap.events.push({ ...snap.events[0], uri: EV("dup"), invitees: [{ ...snap.events[0].invitees[0], email: "other@example.com" }] });
    const r = await importCalendly(snap, { apply: true, actorUserId: null, now: NOW });
    expect(r.bookings.created).toBe(4);
    expect(r.bookings.flagged).toBe(1);
    const [dup] = await sql<{ status: string }[]>`select status from app.bookings where import_ref = ${EV("dup")}`;
    expect(dup.status).toBe("flagged");
  });
});
