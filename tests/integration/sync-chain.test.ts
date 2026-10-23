import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { makeEvent, makeHost } from "../helpers/booking-flow-fixtures";
import { makeBooking } from "../helpers/booking-fixtures";
import { createFakeSlack, type FakeSlack } from "../helpers/slack-fake";
import { linkTestQueue, makeTeam, signedPost, sfUserId } from "../helpers/sync";
import { withUser, type Sql } from "@/server/db/client";
import { runJobs } from "@/server/jobs/worker";
import { createSlackClient, type SlackClient } from "@/server/slack/client";
import { createSlackHandlers } from "@/server/slack/jobs";
import { bookingHandlers } from "@/server/booking/jobs";
import { getAvailableSlots } from "@/server/booking/slots";
import { loadEventTypeById, loadPool } from "@/server/booking/load";
import { manualMemberOverride, requestSyncNow } from "@/server/sync/admin";
import { loadReviewBookings, loadSyncStatus } from "@/server/sync/status";
import { linkUsergroup, resyncUsergroup, setUsergroupDryRun, unlinkUsergroup } from "@/server/slack/usergroup-admin";
import { POST as snapshotPOST } from "@/app/api/sync/queue-snapshot/route";

/**
 * BTCSCHED-51: the Salesforce Queue -> booking pages -> Slack chain end to end, with
 * Salesforce (behind the n8n poller) and Slack replaced by in-memory fakes. Nothing leaves
 * the process.
 */

const QUEUE = "00GVy00000TRvHdMAL";
const BASE = "http://localhost:3000";
const CHANNEL = "C5000001";
const USERGROUP = "S5000001";
const WORKSPACE_ADMIN = "UWSADMIN1";

let sql: Sql;
let slack: FakeSlack;
let client: SlackClient;

beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  slack = createFakeSlack();
  client = createSlackClient({ token: "xoxb-test-token", fetch: slack.fetch });
});

// ---------------------------------------------------------------------------
// Fake Salesforce and the n8n queue poller
// ---------------------------------------------------------------------------

/**
 * Minimal Salesforce REST query endpoint: answers the two SOQL queries the n8n poller runs
 * (GroupMember for the linked queues, then User for the member ids).
 */
function createFakeSalesforce() {
  const queues = new Map<string, Set<string>>();
  const users = new Map<string, { Email: string; IsActive: boolean }>();
  const queries: string[] = [];

  const fetchImpl = async (url: string): Promise<Response> => {
    const soql = new URL(url).searchParams.get("q") ?? "";
    queries.push(soql);
    const ids = [...soql.matchAll(/'([A-Za-z0-9]{15,18})'/g)].map((m) => m[1]);
    let records: Record<string, unknown>[] = [];
    if (/from GroupMember/i.test(soql)) {
      records = ids.flatMap((g) => [...(queues.get(g) ?? [])].map((u) => ({ GroupId: g, UserOrGroupId: u })));
    } else if (/from User/i.test(soql)) {
      records = ids.filter((id) => users.has(id)).map((id) => ({ Id: id, ...users.get(id)! }));
    }
    return new Response(JSON.stringify({ totalSize: records.length, done: true, records }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    queues,
    users,
    queries,
    fetch: fetchImpl,
    addUser(email: string): string {
      const id = sfUserId();
      users.set(id, { Email: email, IsActive: true });
      return id;
    },
  };
}

type FakeSalesforce = ReturnType<typeof createFakeSalesforce>;

let snapSeq = 0;

/** What the n8n "BTC Scheduler - SF Queue Snapshot" workflow does on each run. */
async function n8nPoll(sf: FakeSalesforce, queueIds: string[]): Promise<Response> {
  const base = "https://bigthink.my.salesforce.com/services/data/v60.0/query?q=";
  const inList = queueIds.map((q) => `'${q}'`).join(",");
  const gm = await (await sf.fetch(base + encodeURIComponent(`SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (${inList})`))).json();
  const memberIds = [...new Set((gm.records as { UserOrGroupId: string }[]).map((r) => r.UserOrGroupId))];
  const us = memberIds.length
    ? await (await sf.fetch(base + encodeURIComponent(`SELECT Id, Email, IsActive FROM User WHERE Id IN (${memberIds.map((i) => `'${i}'`).join(",")})`))).json()
    : { records: [] };
  const byId = new Map((us.records as { Id: string; Email: string; IsActive: boolean }[]).map((u) => [u.Id, u]));
  const body = {
    snapshotId: `n8n-exec-${++snapSeq}`,
    takenAt: new Date().toISOString(),
    queues: queueIds.map((queueId) => ({
      queueId,
      members: (gm.records as { GroupId: string; UserOrGroupId: string }[])
        .filter((r) => r.GroupId === queueId && byId.has(r.UserOrGroupId))
        .map((r) => {
          const u = byId.get(r.UserOrGroupId)!;
          return { sfUserId: u.Id, email: u.Email, isActive: u.IsActive };
        }),
    })),
  };
  return snapshotPOST(signedPost(`${BASE}/api/sync/queue-snapshot`, body));
}

/** requestSyncNow with n8n mocked: the "sync now" webhook runs the poller immediately. */
async function syncNow(admin: { id: string; role: "admin" }, teamId: string, sf: FakeSalesforce) {
  let polled: Response | null = null;
  const n8nFetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.bigthinkcapital.com/webhook/btc-scheduler/queue-sync-now");
    const { queueIds } = JSON.parse(String(init.body)) as { queueIds: string[] };
    polled = await n8nPoll(sf, queueIds);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  expect(await requestSyncNow(admin, teamId, { fetch: n8nFetch })).toEqual({ ok: true });
  expect(polled).not.toBeNull();
  expect(polled!.status).toBe(200);
  return (await polled!.json()) as { teams: { teamId: string; status: string; reassignJobs: number; reviewBookings: number }[] };
}

const handlers = () => ({ ...createSlackHandlers({ client: () => client, options: { adminNotifyChannel: null } }), ...bookingHandlers });
const runChainJobs = () =>
  runJobs(handlers(), { sql, deadlineMs: 10_000, kinds: ["slack_membership_sync", "slack_usergroup_sync", "booking_reassign"] });

// ---------------------------------------------------------------------------
// Fixture: a partner team driven by a queue, with a booking page, a channel and a user group
// ---------------------------------------------------------------------------

async function setup(removalPolicy: "reassign" | "keep_bookings") {
  const adminUser = await makeUser(sql, { role: "admin" });
  const admin = { id: adminUser.id, role: "admin" as const };
  const team = await makeTeam(sql, { slug: `partner-${removalPolicy.replace("_", "-")}`, removalPolicy });
  await linkTestQueue(sql, team, QUEUE);

  const repA = await makeHost(sql, { name: "Rep A" });
  const repB = await makeHost(sql, { name: "Rep B" });
  const repC = await makeHost(sql, { name: "Rep C" });
  slack.users.set(repA.email.toLowerCase(), "UREPA0001");
  slack.users.set(repB.email.toLowerCase(), "UREPB0001");
  slack.users.set(repC.email.toLowerCase(), "UREPC0001");

  const sf = createFakeSalesforce();
  const sfA = sf.addUser(repA.email);
  const sfB = sf.addUser(repB.email);
  const sfC = sf.addUser(repC.email);
  sf.queues.set(QUEUE, new Set([sfA, sfB]));

  // Slack: a live add-and-remove channel and user group. The group already holds a workspace
  // admin who is not on the team and must never be touched.
  slack.addChannel({ id: CHANNEL });
  await sql`
    insert into app.team_slack_channels (team_id, channel_id, mode, dry_run) values (${team}, ${CHANNEL}, 'add_and_remove', false)
  `;
  slack.usergroups.set(USERGROUP, [WORKSPACE_ADMIN]);
  slack.admins.add(WORKSPACE_ADMIN);
  const ug = await linkUsergroup(admin.id, team, { usergroupId: USERGROUP, handle: "partner", mode: "add_and_remove" }, { client });
  expect(ug).toMatchObject({ dry_run: true, health: "ok" });
  await setUsergroupDryRun(admin.id, ug.id, false);

  // Booking pages: one round-robin page over all members, one with a per-page host list.
  const allPage = await makeEvent(sql, { teamId: team }, { mode: "round_robin", slug: "consult" });
  const pinnedPage = await makeEvent(sql, { teamId: team }, { mode: "round_robin", slug: "pinned" });

  return { admin, team, repA, repB, repC, sf, sfA, sfB, sfC, allPage, pinnedPage, usergroupConfigId: ug.id };
}

const day = (n: number) => DateTime.utc().startOf("day").plus({ days: n });

async function slotsOn(teamSlug: string, eventSlug: string, d: DateTime) {
  return getAvailableSlots({ kind: "team", slug: teamSlug }, eventSlug, "en", { from: d.toJSDate(), to: d.plus({ days: 1 }).toJSDate() });
}

async function poolUserIds(eventTypeId: string) {
  const loaded = await loadEventTypeById(sql, eventTypeId);
  return (await loadPool(sql, loaded!)).map((h) => h.userId).sort();
}

async function memberStatus(teamId: string) {
  const rows = await sql<{ email: string; status: string; paused_reason: string | null }[]>`
    select email::text as email, status, paused_reason from app.team_members where team_id = ${teamId} order by email
  `;
  return Object.fromEntries(rows.map((r) => [r.email, r.paused_reason ? `${r.status}:${r.paused_reason}` : r.status]));
}

async function teamSlug(teamId: string) {
  const [t] = await sql<{ slug: string }[]>`select slug from app.teams where id = ${teamId}`;
  return t.slug;
}

// ---------------------------------------------------------------------------

describe("queue removal -> booking pages -> Slack (removal_policy reassign)", () => {
  it("removes the rep everywhere in one sync and reassigns their upcoming booking; re-adding reverses it", async () => {
    const f = await setup("reassign");
    const slug = await teamSlug(f.team);

    // 1. First poll: both reps join the team and Slack.
    const first = await syncNow(f.admin, f.team, f.sf);
    expect(first.teams).toMatchObject([{ teamId: f.team, status: "applied" }]);
    expect(await memberStatus(f.team)).toEqual({ [f.repA.email]: "active", [f.repB.email]: "active" });
    await runChainJobs();
    expect([...slack.channels.get(CHANNEL)!.members].sort()).toEqual(["UBOT00001", "UREPA0001", "UREPB0001"]);
    expect(slack.usergroups.get(USERGROUP)!.slice().sort()).toEqual(["UREPA0001", "UREPB0001", WORKSPACE_ADMIN].sort());

    // Per-page host list: the pinned page offers only Rep A.
    const [tmA] = await sql<{ id: string }[]>`select id from app.team_members where team_id = ${f.team} and user_id = ${f.repA.id}`;
    await sql`insert into app.event_type_hosts (event_type_id, team_member_id) values (${f.pinnedPage.id}, ${tmA.id})`;

    // Rep B is busy all of day 3, so day-3 slots on the shared page exist only through Rep A.
    await sql`
      insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at, show_as)
      values (${f.repB.id}, 'busy-day-3', ${day(3).toJSDate()}, ${day(4).toJSDate()}, 'busy')
    `;
    expect((await slotsOn(slug, "consult", day(3))).length).toBeGreaterThan(0);
    expect((await slotsOn(slug, "pinned", day(5))).length).toBeGreaterThan(0);
    expect(await poolUserIds(f.allPage.id)).toEqual([f.repA.id, f.repB.id].sort());

    // Rep A holds an upcoming booking on day 5 (Rep B is free then).
    const start = day(5).set({ hour: 15 });
    const bookingId = await makeBooking(sql, {
      eventTypeId: f.allPage.id,
      hosts: [{ userId: f.repA.id }],
      start: start.toJSDate(),
      end: start.plus({ minutes: 30 }).toJSDate(),
    });

    // 2. Rep A leaves the partner's queue in Salesforce.
    f.sf.queues.get(QUEUE)!.delete(f.sfA);
    const second = await syncNow(f.admin, f.team, f.sf);
    expect(second.teams).toMatchObject([{ teamId: f.team, status: "applied", reassignJobs: 1, reviewBookings: 0 }]);

    // Membership ends and the rep is no longer offered on any page of the team, at once.
    expect(await memberStatus(f.team)).toEqual({ [f.repA.email]: "paused:removed_from_queue", [f.repB.email]: "active" });
    expect(await poolUserIds(f.allPage.id)).toEqual([f.repB.id]);
    expect(await poolUserIds(f.pinnedPage.id)).toEqual([]);
    expect(await slotsOn(slug, "consult", day(3))).toEqual([]);
    expect(await slotsOn(slug, "pinned", day(5))).toEqual([]);

    // Jobs queued in the same transaction: reassignment and both Slack jobs.
    const queued = await sql<{ kind: string }[]>`select kind from app.jobs where status = 'pending' order by kind`;
    expect(queued.map((j) => j.kind)).toEqual(["booking_reassign", "slack_membership_sync", "slack_usergroup_sync"]);
    const [audit] = await sql`select actor_user_id, via, after from app.audit_log where action = 'team_member.queue_sync.remove'`;
    expect(audit).toMatchObject({ actor_user_id: null, via: "sync", after: { source: "poll", removalPolicy: "reassign", reassignJobs: 1 } });

    // 3. The worker executes them against the fakes.
    const report = await runChainJobs();
    expect(report).toMatchObject({ succeeded: 3, dead: 0 });
    const hosts = await sql<{ user_id: string; active: boolean }[]>`
      select user_id, active from app.booking_hosts where booking_id = ${bookingId} order by active desc
    `;
    expect(hosts).toEqual([
      { user_id: f.repB.id, active: true },
      { user_id: f.repA.id, active: false },
    ]);
    const [booking] = await sql`select status from app.bookings where id = ${bookingId}`;
    expect(booking.status).toBe("confirmed");
    expect(slack.channels.get(CHANNEL)!.members.has("UREPA0001")).toBe(false);
    expect(slack.usergroups.get(USERGROUP)!.slice().sort()).toEqual(["UREPB0001", WORKSPACE_ADMIN].sort());
    const ugUpdates = slack.callsTo("usergroups.users.update");
    expect(ugUpdates.at(-1)!.args).toMatchObject({ usergroup: USERGROUP });

    // Re-running every Slack job is idempotent: no further writes.
    const writes = slack.calls.filter((c) => ["conversations.kick", "conversations.invite", "usergroups.users.update"].includes(c.method)).length;
    await resyncUsergroup(f.admin.id, f.usergroupConfigId);
    await runChainJobs();
    expect(slack.calls.filter((c) => ["conversations.kick", "conversations.invite", "usergroups.users.update"].includes(c.method)).length).toBe(writes);

    // 4. Status view for admins.
    const status = await withUser(f.admin.id, (tx) => loadSyncStatus(tx, { teamId: f.team }));
    expect(status.teams[0]).toMatchObject({
      syncHealth: "ok",
      lastRun: { source: "poll", status: "applied", removed: 1, reassign_jobs: 1 },
      lastChangeRun: { removed: 1 },
      slackJobs: { pending: 0, retrying: 0, dead: 0 },
      slackUsergroup: { usergroupId: USERGROUP, dryRun: false, health: "ok" },
      errors: [],
    });

    // 5. The reverse: Rep A is added back, and a new rep joins.
    f.sf.queues.get(QUEUE)!.add(f.sfA);
    f.sf.queues.get(QUEUE)!.add(f.sfC);
    const third = await syncNow(f.admin, f.team, f.sf);
    expect(third.teams).toMatchObject([{ status: "applied" }]);
    expect(await memberStatus(f.team)).toEqual({ [f.repA.email]: "active", [f.repB.email]: "active", [f.repC.email]: "active" });
    // Offered again on the shared page; the new rep joins pages that use all members, not the
    // page with its own host list.
    expect(await poolUserIds(f.allPage.id)).toEqual([f.repA.id, f.repB.id, f.repC.id].sort());
    expect(await poolUserIds(f.pinnedPage.id)).toEqual([f.repA.id]);
    expect((await slotsOn(slug, "consult", day(3))).length).toBeGreaterThan(0);
    await runChainJobs();
    expect([...slack.channels.get(CHANNEL)!.members].sort()).toEqual(["UBOT00001", "UREPA0001", "UREPB0001", "UREPC0001"]);
    expect(slack.usergroups.get(USERGROUP)!.slice().sort()).toEqual(["UREPA0001", "UREPB0001", "UREPC0001", WORKSPACE_ADMIN].sort());
    const actions = await sql`select action, outcome from app.slack_usergroup_actions where outcome = 'done' order by created_at`;
    expect(actions.map((a) => a.action)).toEqual(["add", "add", "remove", "add", "add"]);

    const finalStatus = await withUser(f.admin.id, (tx) => loadSyncStatus(tx, { teamId: f.team }));
    expect(finalStatus.teams[0].lastChangeRun).toMatchObject({ added: 1, reinstated: 1, removed: 0 });
  });
});

describe("queue removal with removal_policy keep_bookings", () => {
  it("keeps the booking with the removed rep and surfaces it for review", async () => {
    const f = await setup("keep_bookings");
    await syncNow(f.admin, f.team, f.sf);
    await runChainJobs();
    const start = day(4).set({ hour: 16 });
    const bookingId = await makeBooking(sql, {
      eventTypeId: f.allPage.id,
      hosts: [{ userId: f.repA.id }],
      start: start.toJSDate(),
      end: start.plus({ minutes: 30 }).toJSDate(),
    });

    f.sf.queues.get(QUEUE)!.delete(f.sfA);
    const res = await syncNow(f.admin, f.team, f.sf);
    expect(res.teams).toMatchObject([{ status: "applied", reassignJobs: 0, reviewBookings: 1 }]);
    expect(await poolUserIds(f.allPage.id)).toEqual([f.repB.id]);
    expect(await sql`select 1 from app.jobs where kind = 'booking_reassign'`).toHaveLength(0);

    const [alert] = await sql`select kind, detail, resolved_at from app.sync_alerts where team_id = ${f.team}`;
    expect(alert).toMatchObject({ kind: "removed_member_bookings", resolved_at: null, detail: { bookingIds: [bookingId], removalPolicy: "keep_bookings" } });
    const review = await withUser(f.admin.id, (tx) => loadReviewBookings(tx, f.team));
    expect(review).toMatchObject([{ bookingId, hostName: "Rep A", memberStatus: "paused", pausedReason: "removed_from_queue", imported: false }]);

    // Slack still follows the roster.
    await runChainJobs();
    expect(slack.channels.get(CHANNEL)!.members.has("UREPA0001")).toBe(false);
    expect(slack.usergroups.get(USERGROUP)).not.toContain("UREPA0001");
    const [host] = await sql`select user_id, active from app.booking_hosts where booking_id = ${bookingId}`;
    expect(host).toEqual({ user_id: f.repA.id, active: true });

    // Adding the rep back resolves their review alert in the same sync, with an audit entry.
    f.sf.queues.get(QUEUE)!.add(f.sfA);
    expect((await syncNow(f.admin, f.team, f.sf)).teams).toMatchObject([{ status: "applied" }]);
    const alerts = await sql<{ id: string; resolved_at: Date | null; detail: Record<string, unknown> }[]>`
      select id, resolved_at, detail from app.sync_alerts where team_id = ${f.team} and kind = 'removed_member_bookings'
    `;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].resolved_at).not.toBeNull();
    expect(alerts[0].detail).toMatchObject({ autoResolved: true, resolvedReason: "member_reinstated" });
    const [audit] = await sql`
      select actor_user_id, via, entity_id, after from app.audit_log where action = 'sync_alert.auto_resolved'
    `;
    expect(audit).toMatchObject({ actor_user_id: null, via: "sync", entity_id: alerts[0].id, after: { reason: "member_reinstated" } });
  });

  it("resolves only the reinstated member's review alert", async () => {
    const f = await setup("keep_bookings");
    await syncNow(f.admin, f.team, f.sf);
    const start = day(5).set({ hour: 16 });
    for (const rep of [f.repA, f.repB]) {
      const s = start.plus({ hours: rep === f.repA ? 0 : 1 });
      await makeBooking(sql, { eventTypeId: f.allPage.id, hosts: [{ userId: rep.id }], start: s.toJSDate(), end: s.plus({ minutes: 30 }).toJSDate() });
    }
    // Remove both reps over two syncs (one removal each stays under the safety rail).
    f.sf.queues.get(QUEUE)!.add(f.sfC);
    await syncNow(f.admin, f.team, f.sf);
    f.sf.queues.get(QUEUE)!.delete(f.sfA);
    await syncNow(f.admin, f.team, f.sf);
    f.sf.queues.get(QUEUE)!.delete(f.sfB);
    await syncNow(f.admin, f.team, f.sf);
    expect(await sql`select 1 from app.sync_alerts where kind = 'removed_member_bookings' and resolved_at is null`).toHaveLength(2);

    f.sf.queues.get(QUEUE)!.add(f.sfA);
    await syncNow(f.admin, f.team, f.sf);
    const [memberB] = await sql<{ id: string }[]>`select id from app.team_members where team_id = ${f.team} and email = ${f.repB.email}`;
    const open = await sql<{ member: string }[]>`
      select detail ->> 'teamMemberId' as member from app.sync_alerts where kind = 'removed_member_bookings' and resolved_at is null
    `;
    expect(open).toEqual([{ member: memberB.id }]);
  });
});

describe("Slack user group safety", () => {
  it("backs off on rate limits, never removes workspace admins, and keeps dry run read-only", async () => {
    const f = await setup("keep_bookings");
    await syncNow(f.admin, f.team, f.sf);
    // The first user group write is rate limited: the job is rescheduled for Retry-After.
    slack.force("usergroups.users.update", { status: 429, headers: { "retry-after": "17" }, body: { ok: false, error: "ratelimited" } });
    const report = await runChainJobs();
    expect(report.retried).toBe(1);
    const [retry] = await sql<{ status: string; delay: number }[]>`
      select status, extract(epoch from (run_at - now()))::int as delay from app.jobs where status = 'failed'
    `;
    expect(retry.status).toBe("failed");
    expect(retry.delay).toBeGreaterThan(10);
    await sql`update app.jobs set run_at = now() where status = 'failed'`;
    expect((await runChainJobs()).dead).toBe(0);
    expect(slack.usergroups.get(USERGROUP)!.slice().sort()).toEqual(["UREPA0001", "UREPB0001", WORKSPACE_ADMIN].sort());

    // A team member who is a workspace admin is never removed from the group.
    slack.admins.add("UREPB0001");
    f.sf.queues.get(QUEUE)!.delete(f.sfB);
    await syncNow(f.admin, f.team, f.sf);
    await runChainJobs();
    expect(slack.usergroups.get(USERGROUP)).toContain("UREPB0001");
    const [skip] = await sql`select action, error_code from app.slack_usergroup_actions where action = 'skip'`;
    expect(skip).toEqual({ action: "skip", error_code: "workspace_admin" });

    // In dry run only reads happen.
    await setUsergroupDryRun(f.admin.id, f.usergroupConfigId, true);
    const before = slack.callsTo("usergroups.users.update").length;
    f.sf.queues.get(QUEUE)!.add(f.sfC);
    await syncNow(f.admin, f.team, f.sf);
    await runChainJobs();
    expect(slack.callsTo("usergroups.users.update")).toHaveLength(before);
    expect(slack.usergroups.get(USERGROUP)).not.toContain("UREPC0001");
    const [would] = await sql`select outcome, dry_run from app.slack_usergroup_actions where outcome = 'would_do'`;
    expect(would).toEqual({ outcome: "would_do", dry_run: true });

    // Unlinking stops user group work; channel jobs continue.
    await unlinkUsergroup(f.admin.id, f.usergroupConfigId);
    const audits = await sql`select action from app.audit_log where entity_type = 'team_slack_usergroup' order by created_at`;
    expect(audits.map((a) => a.action)).toEqual([
      "slack_usergroup.created",
      "slack_usergroup.dry_run_changed",
      "slack_usergroup.dry_run_changed",
      "slack_usergroup.removed",
    ]);
  });

  it("allows only global admins to manage the user group link", async () => {
    const team = await makeTeam(sql);
    const teamAdmin = await makeUser(sql);
    await sql`insert into app.team_admins (team_id, user_id) values (${team}, ${teamAdmin.id})`;
    await expect(linkUsergroup(teamAdmin.id, team, { usergroupId: USERGROUP }, { client })).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      withUser(teamAdmin.id, (tx) => tx`insert into app.team_slack_usergroups (team_id, usergroup_id) values (${team}, ${USERGROUP})`),
    ).rejects.toThrow(/row-level security/);
    const admin = await makeUser(sql, { role: "admin" });
    await expect(linkUsergroup(admin.id, team, { usergroupId: "not-an-id" }, { client })).rejects.toMatchObject({ code: "invalid_input" });
    const row = await linkUsergroup(admin.id, team, { usergroupId: "s5000002" }, { client });
    // Unknown group in the fake workspace: linked, in dry run, with the problem recorded.
    expect(row).toMatchObject({ usergroup_id: "S5000002", dry_run: true, health: "error", mode: "add_only" });
    // Team admins can read the link for their team.
    const visible = await withUser(teamAdmin.id, (tx) => tx`select usergroup_id from app.team_slack_usergroups where team_id = ${team}`);
    expect(visible).toHaveLength(1);
  });
});

describe("teams without Salesforce Queue or Slack links", () => {
  it("run no sync or Slack work (teams imported from Calendly)", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const [imported] = await sql<{ id: string }[]>`
      insert into app.teams (name, slug, membership_source, import_source, import_ref)
      values ('Imported Partner', 'imported-partner', 'manual', 'calendly', 'cal-team-1') returning id
    `;
    const rep = await makeHost(sql, { name: "Imported Rep" });
    const [tm] = await sql<{ id: string }[]>`
      insert into app.team_members (team_id, user_id, email, status, source)
      values (${imported.id}, ${rep.id}, ${rep.email}, 'active', 'manual') returning id
    `;

    // A snapshot naming a queue no team links to changes nothing.
    const res = await n8nPoll(createFakeSalesforce(), [QUEUE]);
    expect(res.status).toBe(422);

    // An admin pause on the imported team writes the event but queues no Slack work.
    await manualMemberOverride({ id: admin.id, role: "admin" }, tm.id, "paused");
    expect(await sql`select kind from app.jobs`).toEqual([]);
    expect(await sql`select 1 from app.queue_sync_runs`).toHaveLength(0);

    const overview = await withUser(admin.id, (tx) => loadSyncStatus(tx));
    expect(overview).toEqual({ teams: [], unlinkedTeams: 1 });
  });
});
