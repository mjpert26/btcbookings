import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { withUser, type Sql } from "@/server/db/client";
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

async function teamWithAdmin(source: "manual" | "salesforce_queue") {
  const ta = await makeUser(sql);
  const [team] = await sql`insert into app.teams (name, slug, membership_source) values ('T', ${"t-" + Math.random().toString(36).slice(2, 8)}, ${source}) returning id`;
  await sql`insert into app.team_admins (team_id, user_id) values (${team.id}, ${ta.id})`;
  return { ta, teamId: team.id as string };
}

describe("team admin limits", () => {
  it("cannot change sync or safety-rail settings, but can change the conflict policy", async () => {
    const { ta, teamId } = await teamWithAdmin("salesforce_queue");
    await expect(withUser(ta.id, (tx) => tx`update app.teams set mass_removal_threshold_pct = 100 where id = ${teamId}`)).rejects.toThrow(/only admins/);
    await expect(withUser(ta.id, (tx) => tx`update app.teams set membership_source = 'manual' where id = ${teamId}`)).rejects.toThrow(/only admins/);
    await withUser(ta.id, (tx) => tx`update app.teams set outlook_conflict_policy = 'auto_cancel', name = 'Renamed' where id = ${teamId}`);
    const admin = await makeUser(sql, { role: "admin" });
    await withUser(admin.id, (tx) => tx`update app.teams set mass_removal_threshold_pct = 30 where id = ${teamId}`);
  });

  it("cannot add or pause members on queue-linked teams, but can on manual teams", async () => {
    const q = await teamWithAdmin("salesforce_queue");
    await expect(withUser(q.ta.id, (tx) => tx`insert into app.team_members (team_id, email) values (${q.teamId}, 'x@bigthinkcapital.com')`)).rejects.toThrow(/managed by sync/);
    await sql`insert into app.team_members (team_id, email, source) values (${q.teamId}, 'y@bigthinkcapital.com', 'queue')`;
    await expect(withUser(q.ta.id, (tx) => tx`update app.team_members set status = 'paused' where team_id = ${q.teamId}`)).rejects.toThrow(/managed by sync/);
    await withUser(q.ta.id, (tx) => tx`update app.team_members set weight = 3 where team_id = ${q.teamId}`);
    await expect(withUser(q.ta.id, (tx) => tx`update app.team_members set rr_assignment_count = 5 where team_id = ${q.teamId}`)).rejects.toThrow(/system-managed/);

    const m = await teamWithAdmin("manual");
    await withUser(m.ta.id, (tx) => tx`insert into app.team_members (team_id, email) values (${m.teamId}, 'z@bigthinkcapital.com')`);
    await withUser(m.ta.id, (tx) => tx`update app.team_members set status = 'paused' where team_id = ${m.teamId}`);
  });
});

describe("reassigned hosts", () => {
  it("lose read and cancel access to a booking moved to someone else", async () => {
    const oldHost = await makeUser(sql);
    const newHost = await makeUser(sql);
    const owner = await makeUser(sql);
    const [et] = await sql`insert into app.event_types (owner_user_id, slug, name) values (${owner.id}, 'e', 'E') returning id`;
    const [b] = await sql`
      insert into app.bookings (event_type_id, start_at, end_at, invitee_name, invitee_email, invitee_timezone, location_type, manage_token_hash)
      values (${et.id}, now() + interval '2 days', now() + interval '2 days 30 minutes', 'I', 'i@example.com', 'UTC', 'teams', 'h1')
      returning id`;
    await sql`insert into app.booking_hosts (booking_id, user_id, blocked_range, active, reassigned_at)
              values (${b.id}, ${oldHost.id}, tstzrange(now() + interval '2 days', now() + interval '2 days 30 minutes'), false, now())`;
    await sql`insert into app.booking_hosts (booking_id, user_id, blocked_range, active)
              values (${b.id}, ${newHost.id}, tstzrange(now() + interval '2 days', now() + interval '2 days 30 minutes'), true)`;

    expect(await withUser(oldHost.id, (tx) => tx`select id from app.bookings where id = ${b.id}`)).toHaveLength(0);
    expect(await cancelBookingAsHost(oldHost.id, b.id, null)).toMatchObject({ ok: false, reason: "not_found" });
    const [still] = await sql`select status from app.bookings where id = ${b.id}`;
    expect(still.status).toBe("confirmed");
    const [nh] = await sql`select active from app.booking_hosts where booking_id = ${b.id} and user_id = ${newHost.id}`;
    expect(nh.active).toBe(true);

    expect(await withUser(newHost.id, (tx) => tx`select id from app.bookings where id = ${b.id}`)).toHaveLength(1);
    expect(await cancelBookingAsHost(newHost.id, b.id, "conflict")).toMatchObject({ ok: true });
  });
});

describe("event type schedules", () => {
  it("cannot attach another user's schedule", async () => {
    const a = await makeUser(sql);
    const b = await makeUser(sql);
    const [sch] = await sql`insert into app.availability_schedules (owner_user_id, name) values (${b.id}, 'B hours') returning id`;
    await expect(
      withUser(a.id, (tx) => tx`insert into app.event_types (owner_user_id, slug, name, schedule_id) values (${a.id}, 's', 'S', ${sch.id})`),
    ).rejects.toThrow(/schedule not accessible/);
  });
});

describe("offboarding", () => {
  it("revokes sessions when Entra reports the account disabled", async () => {
    const { getGraphAccessToken } = await import("@/server/graph/tokens");
    const { TokenError } = await import("@/server/auth/entra");
    const { encryptSecret } = await import("@/server/crypto/aes");
    const u = await makeUser(sql, { calendar: null });
    await sql`insert into app.calendar_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at)
              values (${u.id}, ${encryptSecret("a", u.id)}, ${encryptSecret("r", u.id)}, now() - interval '1 minute')`;
    await sql`insert into app.sessions (id, user_id, expires_at) values ('s1', ${u.id}, now() + interval '1 day')`;
    await expect(
      getGraphAccessToken(u.id, async () => {
        throw new TokenError("Token endpoint error invalid_grant: AADSTS50057: User account is disabled.", true, "invalid_grant");
      }),
    ).rejects.toThrow();
    expect(await sql`select id from app.sessions where user_id = ${u.id}`).toHaveLength(0);
  });

  it("lets admins deactivate a user and revokes their sessions", async () => {
    const { setUserActive } = await import("@/server/auth/admin");
    const admin = await makeUser(sql, { role: "admin" });
    const u = await makeUser(sql);
    await sql`insert into app.sessions (id, user_id, expires_at) values ('s2', ${u.id}, now() + interval '1 day')`;
    await expect(setUserActive({ id: u.id }, admin.id, false)).rejects.toThrow(/Only admins/);
    await setUserActive({ id: admin.id }, u.id, false);
    expect(await sql`select id from app.sessions where user_id = ${u.id}`).toHaveLength(0);
    const [row] = await sql`select is_active from app.users where id = ${u.id}`;
    expect(row.is_active).toBe(false);
  });
});

describe("queue push removal budget", () => {
  it("defers a burst of push removals to the poller and raises one alert", async () => {
    const { applyPushChange } = await import("@/server/sync/apply");
    const [team] = await sql`insert into app.teams (name, slug, membership_source) values ('Q', 'q-budget', 'salesforce_queue') returning id`;
    const queueId = "00GVy00000TRvHdMAL";
    await sql`insert into app.team_sf_queues (team_id, queue_id) values (${team.id}, ${queueId})`;
    for (let i = 0; i < 6; i++) {
      await sql`insert into app.team_members (team_id, email, source, status) values (${team.id}, ${`m${i}@bigthinkcapital.com`}, 'queue', 'active')`;
    }
    const results = [];
    for (let i = 0; i < 6; i++) {
      const r = await applyPushChange({ eventId: `e${i}`, action: "removed", queueId, email: `m${i}@bigthinkcapital.com` });
      results.push(r.teams[0].status);
    }
    expect(results.filter((s) => s === "applied")).toHaveLength(3);
    expect(results.filter((s) => s === "blocked")).toHaveLength(3);
    const [{ n }] = await sql`select count(*)::int as n from app.team_members where team_id = ${team.id} and status = 'active'`;
    expect(n).toBe(3);
    const alerts = await sql`select kind from app.sync_alerts where team_id = ${team.id}`;
    expect(alerts.map((a) => a.kind)).toEqual(["push_removal_budget_exceeded"]);
  });
});
