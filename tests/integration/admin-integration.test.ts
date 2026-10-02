import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { graphError, installGraphMock, json, resetGraph, type GraphMock } from "../helpers/graph-mock";
import { makeTeam } from "../helpers/sync";
import { withUser, type Sql } from "@/server/db/client";
import { withAuditContext } from "@/server/audit";
import { addManualMember, createTeam, manualMemberOverride, removeManualMember } from "@/server/sync/admin";
import { disconnectCalendar } from "@/server/graph/disconnect";
import { loadAdminCounts } from "@/server/ui/overview";

/**
 * Roster changes made from the internal UI (team admins and admins), team creation, the
 * Outlook disconnect and the admin overview counts.
 */

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

type Actor = { id: string; role: "user" | "admin" };

async function actors() {
  const admin = await makeUser(sql, { role: "admin" });
  const teamAdmin = await makeUser(sql);
  const outsider = await makeUser(sql);
  return {
    admin: { id: admin.id, role: "admin" } as Actor,
    teamAdmin: { id: teamAdmin.id, role: "user" } as Actor,
    outsider: { id: outsider.id, role: "user" } as Actor,
  };
}

async function member(teamId: string, email: string, userId: string | null, source: "manual" | "queue" = "manual", status = "active") {
  const [m] = await sql<{ id: string }[]>`
    insert into app.team_members (team_id, user_id, email, status, source)
    values (${teamId}, ${userId}, ${email}, ${status}, ${source}) returning id
  `;
  return m.id;
}

async function booking(teamId: string, hostUserId: string, startOffsetHours: number, opts: { status?: string; role?: string } = {}) {
  const [et] = await sql<{ id: string }[]>`
    insert into app.event_types (team_id, slug, name, scheduling_mode)
    values (${teamId}, ${"et-" + Math.random().toString(36).slice(2, 8)}, 'Intro', 'round_robin') returning id
  `;
  const start = new Date(Date.now() + startOffsetHours * 3600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const [b] = await sql<{ id: string }[]>`
    insert into app.bookings (event_type_id, status, start_at, end_at, invitee_name, invitee_email, invitee_timezone, location_type, manage_token_hash)
    values (${et.id}, ${opts.status ?? "confirmed"}, ${start}, ${end}, 'Invitee', 'invitee@example.com', 'America/New_York', 'teams', ${"h" + Math.random()})
    returning id
  `;
  await sql`
    insert into app.booking_hosts (booking_id, user_id, role, blocked_range, active)
    values (${b.id}, ${hostUserId}, ${opts.role ?? "primary"}, tstzrange(${start}, ${end}), ${opts.status !== "cancelled"})
  `;
  return b.id;
}

const count = async (q: string) => Number((await sql.unsafe(q))[0].n);

describe("manualMemberOverride from the team page", () => {
  it("lets a team admin pause and unpause, writing the event, Slack job and audit entry", async () => {
    const { teamAdmin, outsider } = await actors();
    const team = await makeTeam(sql, { membershipSource: "manual" });
    await sql`insert into app.team_admins (team_id, user_id) values (${team}, ${teamAdmin.id})`;
    const rep = await makeUser(sql);
    const tm = await member(team, rep.email, rep.id);

    await expect(manualMemberOverride(outsider, tm, "paused")).rejects.toMatchObject({ code: "forbidden" });
    const paused = await withAuditContext({ ipHash: "iphash-1" }, () => manualMemberOverride(teamAdmin, tm, "paused", "vacation", { teamId: team }));
    expect(paused).toMatchObject({ changed: true, status: "paused", reassignJobs: 0 });
    const [row] = await sql`select status, paused_reason from app.team_members where id = ${tm}`;
    expect(row).toEqual({ status: "paused", paused_reason: "admin_override" });
    const [ev] = await sql`select source, actor_user_id, old_status, new_status from app.membership_events where id = ${paused.membershipEventId}`;
    expect(ev).toEqual({ source: "admin", actor_user_id: teamAdmin.id, old_status: "active", new_status: "paused" });
    expect(await sql`select 1 from app.jobs where kind = 'slack_membership_sync' and idempotency_key = ${"membership_event:" + paused.membershipEventId}`).toHaveLength(1);
    const [audit] = await sql`select action, ip_hash from app.audit_log where entity_id = ${tm}`;
    expect(audit).toEqual({ action: "team_member.status_override", ip_hash: "iphash-1" });

    const resumed = await manualMemberOverride(teamAdmin, tm, "active", undefined, { teamId: team, checkOnboarding: true });
    expect(resumed).toMatchObject({ changed: true, status: "active" });
    // The member is on another team: the page's team id must match.
    const other = await makeTeam(sql, { membershipSource: "manual" });
    await expect(manualMemberOverride(teamAdmin, tm, "paused", undefined, { teamId: other })).rejects.toMatchObject({ code: "not_found" });
  });

  it("sets pending_onboarding instead of active when the member has no healthy Outlook connection", async () => {
    const { admin } = await actors();
    const team = await makeTeam(sql, { membershipSource: "manual" });
    const broken = await makeUser(sql, { calendar: "broken" });
    const tm = await member(team, broken.email, broken.id, "manual", "paused");
    const res = await manualMemberOverride(admin, tm, "active", undefined, { checkOnboarding: true });
    expect(res.status).toBe("pending_onboarding");
    const noUser = await member(team, "later@bigthinkcapital.com", null, "manual", "paused");
    expect((await manualMemberOverride(admin, noUser, "active", undefined, { checkOnboarding: true })).status).toBe("pending_onboarding");
    // Without the check, an admin override sets exactly the requested status.
    expect((await manualMemberOverride(admin, noUser, "active")).status).toBe("active");
  });

  it("enqueues booking_reassign for future confirmed bookings when removal_policy is reassign", async () => {
    const { teamAdmin } = await actors();
    const reassign = await makeTeam(sql, { membershipSource: "manual", removalPolicy: "reassign" });
    const keep = await makeTeam(sql, { membershipSource: "manual", removalPolicy: "keep_bookings" });
    await sql`insert into app.team_admins (team_id, user_id) values (${reassign}, ${teamAdmin.id}), (${keep}, ${teamAdmin.id})`;
    const host = await makeUser(sql);
    const tmR = await member(reassign, host.email, host.id);
    const tmK = await member(keep, host.email, host.id);

    const future = await booking(reassign, host.id, 48);
    const later = await booking(reassign, host.id, 96);
    await booking(reassign, host.id, -48); // past
    await booking(reassign, host.id, 72, { status: "cancelled" });
    await booking(reassign, host.id, 80, { role: "collective" });
    await booking(keep, host.id, 50); // other team

    const res = await manualMemberOverride(teamAdmin, tmR, "paused");
    expect(res.reassignJobs).toBe(2);
    const jobs = await sql<{ payload: Record<string, string>; booking_id: string; team_id: string; idempotency_key: string }[]>`
      select payload, booking_id, team_id, idempotency_key from app.jobs where kind = 'booking_reassign' order by created_at, booking_id
    `;
    expect(jobs.map((j) => j.booking_id).sort()).toEqual([future, later].sort());
    for (const j of jobs) {
      expect(j.payload).toEqual({ bookingId: j.booking_id, fromUserId: host.id, reason: "paused_by_admin" });
      expect(j.team_id).toBe(reassign);
      expect(j.idempotency_key).toBe(`reassign:${j.booking_id}:${res.membershipEventId}`);
    }

    expect((await manualMemberOverride(teamAdmin, tmK, "paused")).reassignJobs).toBe(0);
    expect(await count("select count(*) as n from app.jobs where kind = 'booking_reassign'")).toBe(2);
    // Unpausing never reassigns.
    await manualMemberOverride(teamAdmin, tmR, "active");
    expect(await count("select count(*) as n from app.jobs where kind = 'booking_reassign'")).toBe(2);
  });

  it("refuses to enqueue reassignments for an event the caller did not write", async () => {
    const { admin, teamAdmin } = await actors();
    const team = await makeTeam(sql, { membershipSource: "manual", removalPolicy: "reassign" });
    await sql`insert into app.team_admins (team_id, user_id) values (${team}, ${teamAdmin.id})`;
    const host = await makeUser(sql);
    const tm = await member(team, host.email, host.id);
    await booking(team, host.id, 48);
    const res = await manualMemberOverride(admin, tm, "paused");
    expect(res.reassignJobs).toBe(1);
    await expect(withUser(teamAdmin.id, (tx) => tx`select app.enqueue_member_reassignments(${res.membershipEventId})`)).rejects.toThrow(
      /membership event not found/,
    );
  });
});

describe("manual members", () => {
  it("adds a manual member with the right status, event and Slack job", async () => {
    const { teamAdmin, outsider } = await actors();
    const team = await makeTeam(sql, { membershipSource: "queue_plus_manual" });
    await sql`insert into app.team_admins (team_id, user_id) values (${team}, ${teamAdmin.id})`;
    const ready = await makeUser(sql, { email: "ready@bigthinkcapital.com" });

    await expect(addManualMember(outsider, team, "ready@bigthinkcapital.com")).rejects.toMatchObject({ code: "forbidden" });
    await expect(addManualMember(teamAdmin, team, "someone@example.com")).rejects.toMatchObject({ code: "invalid" });
    const added = await addManualMember(teamAdmin, team, "Ready@BigThinkCapital.com");
    expect(added.status).toBe("active");
    const [m] = await sql`select user_id, source, status from app.team_members where id = ${added.teamMemberId}`;
    expect(m).toEqual({ user_id: ready.id, source: "manual", status: "active" });
    expect(await sql`select 1 from app.jobs where idempotency_key = ${"membership_event:" + added.membershipEventId}`).toHaveLength(1);
    await expect(addManualMember(teamAdmin, team, "ready@bigthinkcapital.com")).rejects.toMatchObject({ code: "conflict" });
    expect((await addManualMember(teamAdmin, team, "new.hire@bigthinkcapital.com")).status).toBe("pending_onboarding");
    expect(await count("select count(*) as n from app.audit_log where action = 'team_member.add'")).toBe(2);

    const queueOnly = await makeTeam(sql, { membershipSource: "salesforce_queue" });
    await sql`insert into app.team_admins (team_id, user_id) values (${queueOnly}, ${teamAdmin.id})`;
    await expect(addManualMember(teamAdmin, queueOnly, "ready@bigthinkcapital.com")).rejects.toMatchObject({ code: "invalid" });
  });

  it("removes only manual members without upcoming bookings", async () => {
    const { teamAdmin, outsider } = await actors();
    const team = await makeTeam(sql, { membershipSource: "queue_plus_manual" });
    await sql`insert into app.team_admins (team_id, user_id) values (${team}, ${teamAdmin.id})`;
    const busy = await makeUser(sql);
    const free = await makeUser(sql);
    const queued = await makeUser(sql);
    const tmBusy = await member(team, busy.email, busy.id);
    const tmFree = await member(team, free.email, free.id);
    const tmQueue = await member(team, queued.email, queued.id, "queue");
    await booking(team, busy.id, 24);
    await booking(team, free.id, -24); // past bookings do not block removal

    await expect(removeManualMember(outsider, tmFree)).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeManualMember(teamAdmin, tmQueue)).rejects.toMatchObject({ code: "invalid" });
    await expect(removeManualMember(teamAdmin, tmBusy)).rejects.toMatchObject({ code: "conflict" });

    const res = await removeManualMember(teamAdmin, tmFree, { teamId: team });
    expect(await sql`select 1 from app.team_members where id = ${tmFree}`).toHaveLength(0);
    const [ev] = await sql`select team_member_id, old_status, new_status, detail from app.membership_events where id = ${res.membershipEventId}`;
    expect(ev).toMatchObject({ team_member_id: null, old_status: "active", new_status: null, detail: { change: "removed", team_member_id: tmFree } });
    const [job] = await sql`select payload from app.jobs where idempotency_key = ${"membership_event:" + res.membershipEventId}`;
    expect(job.payload).toEqual({ teamId: team, teamMemberId: tmFree });
    const [audit] = await sql`select actor_user_id, before from app.audit_log where action = 'team_member.remove'`;
    expect(audit).toMatchObject({ actor_user_id: teamAdmin.id, before: { email: free.email, source: "manual" } });
  });
});

describe("createTeam", () => {
  it("creates a team for admins only and audits it", async () => {
    const { admin, teamAdmin } = await actors();
    await expect(createTeam(teamAdmin, { name: "Ops", slug: "ops" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createTeam(admin, { name: "Ops", slug: "Not a slug!" })).rejects.toMatchObject({ code: "invalid" });
    const t = await createTeam(admin, { name: "Ops", slug: "ops", description: "Operations", membershipSource: "queue_plus_manual" });
    const [row] = await sql`select name, slug, description, membership_source from app.teams where id = ${t.id}`;
    expect(row).toEqual({ name: "Ops", slug: "ops", description: "Operations", membership_source: "queue_plus_manual" });
    expect(await count("select count(*) as n from app.audit_log where action = 'team.create'")).toBe(1);
    await expect(createTeam(admin, { name: "Ops 2", slug: "ops" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("disconnectCalendar", () => {
  it("deletes the subscription, clears tokens and marks the connection disconnected", async () => {
    const u = await makeUser(sql);
    await sql`
      update app.calendar_connections
      set subscription_id = 'sub-1', client_state_hash = 'h', access_token_enc = 'a', refresh_token_enc = 'r',
          token_expires_at = now() + interval '1 hour', delta_link_enc = 'd'
      where user_id = ${u.id}
    `;
    mock.on("DELETE", /\/subscriptions\/sub-1$/, json(204, null));
    expect(await disconnectCalendar(u.id)).toEqual({ disconnected: true, subscriptionDeleted: true });
    expect(mock.callsTo("DELETE", /\/subscriptions\/sub-1$/)).toHaveLength(1);
    const [cc] = await sql`
      select status, access_token_enc, refresh_token_enc, token_expires_at, delta_link_enc, subscription_id, client_state_hash
      from app.calendar_connections where user_id = ${u.id}
    `;
    expect(cc).toEqual({
      status: "disconnected",
      access_token_enc: null,
      refresh_token_enc: null,
      token_expires_at: null,
      delta_link_enc: null,
      subscription_id: null,
      client_state_hash: null,
    });
    const [audit] = await sql`select actor_user_id, action, before from app.audit_log where action = 'calendar.disconnect'`;
    expect(audit).toEqual({ actor_user_id: u.id, action: "calendar.disconnect", before: { status: "healthy" } });
  });

  it("still disconnects when Graph rejects the subscription delete", async () => {
    const u = await makeUser(sql);
    await sql`update app.calendar_connections set subscription_id = 'sub-2', access_token_enc = 'a' where user_id = ${u.id}`;
    mock.on("DELETE", /\/subscriptions\/sub-2$/, graphError(403, "Forbidden"));
    expect(await disconnectCalendar(u.id)).toEqual({ disconnected: true, subscriptionDeleted: false });
    const [cc] = await sql`select status, access_token_enc from app.calendar_connections where user_id = ${u.id}`;
    expect(cc).toEqual({ status: "disconnected", access_token_enc: null });
    const none = await makeUser(sql, { calendar: null });
    expect(await disconnectCalendar(none.id)).toEqual({ disconnected: false, subscriptionDeleted: true });
  });
});

describe("admin overview counts", () => {
  it("counts open alerts, dead lead jobs, unhealthy Slack channels and broken Outlook connections", async () => {
    const { admin } = await actors();
    const team = await makeTeam(sql);
    await sql`insert into app.sync_alerts (team_id, kind) values (${team}, 'mass_removal_blocked'), (${team}, 'sync_stale')`;
    await sql`insert into app.sync_alerts (team_id, kind, resolved_at) values (${team}, 'sync_stale', now())`;
    await sql`
      insert into app.jobs (kind, status, idempotency_key) values
        ('sf_lead_create', 'dead', 'd1'), ('sf_lead_create', 'failed', 'f1'), ('sf_lead_create', 'succeeded', 's1'),
        ('email_send', 'dead', 'e1')
    `;
    await sql`
      insert into app.team_slack_channels (team_id, channel_id, health) values
        (${team}, 'C0000001', 'ok'), (${team}, 'C0000002', 'unknown'), (${team}, 'C0000003', 'bot_not_in_channel'), (${team}, 'C0000004', 'error')
    `;
    await makeUser(sql, { calendar: "broken" });
    const inactive = await makeUser(sql, { calendar: "broken" });
    await sql`update app.users set is_active = false where id = ${inactive.id}`;
    const off = await makeUser(sql);
    await sql`update app.calendar_connections set status = 'disconnected' where user_id = ${off.id}`;

    const counts = await withUser(admin.id, (tx) => loadAdminCounts(tx));
    expect(counts).toEqual({
      openSyncAlerts: 2,
      deadSfLeadJobs: 1,
      failedSfLeadJobs: 1,
      slackChannelIssues: 3,
      brokenOutlookConnections: 1,
    });
  });
});
