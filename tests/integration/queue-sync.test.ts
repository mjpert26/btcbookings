import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { linkTestQueue, makeTeam, PUSH_BEARER, sfUserId, signedHeaders, signedPost, SYNC_SECRET } from "../helpers/sync";
import type { Sql } from "@/server/db/client";
import { computeSignature } from "@/server/crypto/hmac";
import { applySnapshot, type SnapshotInput } from "@/server/sync/apply";
import { checkQueueSyncHealth } from "@/server/sync/health";
import {
  linkQueue,
  manualMemberOverride,
  requestSyncNow,
  resolveAlert,
  setTeamSyncSettings,
  SyncAdminError,
  unlinkQueue,
} from "@/server/sync/admin";
import { POST as snapshotPOST } from "@/app/api/sync/queue-snapshot/route";
import { POST as pushPOST } from "@/app/api/sync/queue-membership/route";
import { GET as linkedGET } from "@/app/api/sync/linked-queues/route";
import { GET as healthGET } from "@/app/api/cron/queue-sync-health/route";

const Q1 = "00GVy00000TRvHdMAL";
const Q2 = "00GVy00000SRIlVMAX";
const Q_UNLINKED = "00GVy00000WQWhlMAH";
const BASE = "http://localhost:3000";

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

type M = { sfUserId: string; email: string; isActive: boolean };
const people = new Map<string, string>();
const m = (email: string, isActive = true): M => {
  if (!people.has(email)) people.set(email, sfUserId());
  return { sfUserId: people.get(email)!, email, isActive };
};
let snapSeq = 0;
const snapshot = (queues: { queueId: string; members: M[] }[]): SnapshotInput => ({
  snapshotId: `snap-${++snapSeq}`,
  takenAt: new Date().toISOString(),
  queues,
});

async function members(teamId: string) {
  return sql<{ id: string; email: string; status: string; source: string; paused_reason: string | null; user_id: string | null; rr_assignment_count: number; rr_last_assigned_at: Date | null }[]>`
    select id, email::text as email, status, source, paused_reason, user_id, rr_assignment_count, rr_last_assigned_at
    from app.team_members where team_id = ${teamId} order by email
  `;
}
const statusOf = async (teamId: string) => Object.fromEntries((await members(teamId)).map((r) => [r.email, r.status]));
const count = async (q: string) => Number((await sql.unsafe(q))[0].n);

async function teamBooking(teamId: string, hostUserId: string, startOffsetHours: number, status = "confirmed") {
  const [et] = await sql<{ id: string }[]>`
    insert into app.event_types (team_id, slug, name, scheduling_mode)
    values (${teamId}, ${"et-" + Math.random().toString(36).slice(2, 8)}, 'Intro', 'round_robin') returning id
  `;
  const start = new Date(Date.now() + startOffsetHours * 3600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const [b] = await sql<{ id: string }[]>`
    insert into app.bookings (event_type_id, status, start_at, end_at, invitee_name, invitee_email, invitee_timezone, location_type, manage_token_hash)
    values (${et.id}, ${status}, ${start}, ${end}, 'Invitee', 'invitee@example.com', 'America/New_York', 'teams', ${"h" + Math.random()})
    returning id
  `;
  await sql`
    insert into app.booking_hosts (booking_id, user_id, role, blocked_range)
    values (${b.id}, ${hostUserId}, 'primary', tstzrange(${start}, ${end}))
  `;
  return b.id;
}

// ---------------------------------------------------------------------------
describe("applySnapshot", () => {
  it("adds members, writes events and Slack jobs, and records sync state", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const ready = await makeUser(sql, { email: "ready@bigthinkcapital.com" });
    await makeUser(sql, { email: "broken@bigthinkcapital.com", calendar: "broken" });

    const res = await applySnapshot(
      snapshot([{ queueId: Q1, members: [m("Ready@BigThinkCapital.com"), m("broken@bigthinkcapital.com"), m("nobody@bigthinkcapital.com")] }]),
    );
    expect(res.teams[0]).toMatchObject({ status: "applied", events: 3 });
    const rows = await members(team);
    expect(rows.map((r) => [r.email, r.status, r.source])).toEqual([
      ["broken@bigthinkcapital.com", "pending_onboarding", "queue"],
      ["nobody@bigthinkcapital.com", "pending_onboarding", "queue"],
      ["ready@bigthinkcapital.com", "active", "queue"],
    ]);
    expect(rows.find((r) => r.email.startsWith("ready"))!.user_id).toBe(ready.id);

    const events = await sql`select id, source, old_status, new_status from app.membership_events where team_id = ${team}`;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.source === "poll" && e.old_status === null)).toBe(true);
    const jobs = await sql`select payload, idempotency_key from app.jobs where kind = 'slack_membership_sync'`;
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.idempotency_key).sort()).toEqual(events.map((e) => `membership_event:${e.id}`).sort());

    const [t] = await sql`select sync_health, last_synced_at from app.teams where id = ${team}`;
    expect(t.sync_health).toBe("ok");
    expect(t.last_synced_at).not.toBeNull();
    const [q] = await sql`select last_snapshot_at, last_snapshot_hash, last_member_count from app.team_sf_queues where team_id = ${team}`;
    expect(q.last_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(q.last_member_count).toBe(3);
  });

  it("is idempotent: the same snapshot twice writes nothing new", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const s = snapshot([{ queueId: Q1, members: [m("a@bigthinkcapital.com"), m("b@bigthinkcapital.com")] }]);
    await applySnapshot(s);
    const again = await applySnapshot({ ...s, snapshotId: "snap-repeat" });
    expect(again.teams[0]).toMatchObject({ status: "applied", events: 0 });
    expect(await count("select count(*) as n from app.membership_events")).toBe(2);
    expect(await count("select count(*) as n from app.jobs")).toBe(2);
  });

  it("pauses and reinstates without touching round-robin counters", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    for (const e of ["a", "b", "c"]) await makeUser(sql, { email: `${e}@bigthinkcapital.com` });
    const all = ["a", "b", "c"].map((e) => m(`${e}@bigthinkcapital.com`));
    await applySnapshot(snapshot([{ queueId: Q1, members: all }]));
    const assignedAt = new Date("2026-09-30T15:00:00Z");
    await sql`update app.team_members set rr_assignment_count = 7, rr_last_assigned_at = ${assignedAt} where email = 'c@bigthinkcapital.com'`;

    await applySnapshot(snapshot([{ queueId: Q1, members: all.slice(0, 2) }]));
    let c = (await members(team)).find((r) => r.email.startsWith("c@"))!;
    expect(c).toMatchObject({ status: "paused", paused_reason: "removed_from_queue", rr_assignment_count: 7 });

    await applySnapshot(snapshot([{ queueId: Q1, members: all }]));
    c = (await members(team)).find((r) => r.email.startsWith("c@"))!;
    expect(c).toMatchObject({ status: "active", paused_reason: null, rr_assignment_count: 7 });
    expect(new Date(c.rr_last_assigned_at!).toISOString()).toBe(assignedAt.toISOString());
    const evs = await sql`select old_status, new_status from app.membership_events where email = 'c@bigthinkcapital.com' order by created_at`;
    expect(evs.map((e) => [e.old_status, e.new_status])).toEqual([
      [null, "active"],
      ["active", "paused"],
      ["paused", "active"],
    ]);
  });

  it("leaves manual members alone", async () => {
    const team = await makeTeam(sql, { membershipSource: "queue_plus_manual" });
    await linkTestQueue(sql, team, Q1);
    await sql`insert into app.team_members (team_id, email, status, source) values
      (${team}, 'manual@bigthinkcapital.com', 'active', 'manual'),
      (${team}, 'both@bigthinkcapital.com', 'paused', 'manual')`;
    await applySnapshot(snapshot([{ queueId: Q1, members: [m("both@bigthinkcapital.com"), m("q@bigthinkcapital.com")] }]));
    const rows = await members(team);
    expect(rows.map((r) => [r.email, r.status, r.source])).toEqual([
      ["both@bigthinkcapital.com", "paused", "manual"],
      ["manual@bigthinkcapital.com", "active", "manual"],
      ["q@bigthinkcapital.com", "pending_onboarding", "queue"],
    ]);
  });

  it("unions multiple queues and skips manual teams", async () => {
    const team = await makeTeam(sql);
    const manualTeam = await makeTeam(sql, { membershipSource: "manual" });
    await linkTestQueue(sql, team, Q1);
    await linkTestQueue(sql, team, Q2);
    await linkTestQueue(sql, manualTeam, Q1);
    const res = await applySnapshot(
      snapshot([
        { queueId: Q1, members: [m("a@bigthinkcapital.com"), m("shared@bigthinkcapital.com")] },
        { queueId: Q2, members: [m("shared@bigthinkcapital.com"), m("b@bigthinkcapital.com")] },
      ]),
    );
    expect(res.teams.find((t) => t.teamId === manualTeam)).toMatchObject({ status: "skipped", reason: "manual_team" });
    expect((await members(team)).map((r) => r.email)).toEqual([
      "a@bigthinkcapital.com",
      "b@bigthinkcapital.com",
      "shared@bigthinkcapital.com",
    ]);
    expect(await members(manualTeam)).toHaveLength(0);
  });

  it("safety rail: blocks, alerts once, and changes nothing", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const four = ["a", "b", "c", "d"].map((e) => m(`${e}@bigthinkcapital.com`));
    await applySnapshot(snapshot([{ queueId: Q1, members: four }]));
    const before = await statusOf(team);
    const eventsBefore = await count("select count(*) as n from app.membership_events");
    const [qBefore] = await sql`select last_snapshot_hash from app.team_sf_queues`;

    const res = await applySnapshot(snapshot([{ queueId: Q1, members: four.slice(0, 1) }]));
    expect(res.teams[0]).toMatchObject({ status: "blocked", reason: "threshold", counts: { removals: 3 } });
    await applySnapshot(snapshot([{ queueId: Q1, members: four.slice(0, 1) }]));

    expect(await statusOf(team)).toEqual(before);
    expect(await count("select count(*) as n from app.membership_events")).toBe(eventsBefore);
    const alerts = await sql`select kind, detail, resolved_at from app.sync_alerts where team_id = ${team}`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("mass_removal_blocked");
    expect(alerts[0].detail.counts.removals).toBe(3);
    expect(JSON.stringify(alerts[0].detail)).not.toContain("@");
    const [t] = await sql`select sync_health from app.teams where id = ${team}`;
    expect(t.sync_health).toBe("blocked");
    const [qAfter] = await sql`select last_snapshot_hash from app.team_sf_queues`;
    expect(qAfter.last_snapshot_hash).toBe(qBefore.last_snapshot_hash);
  });

  it("safety rail: an empty snapshot for a queue that had members is blocked", async () => {
    const team = await makeTeam(sql, { thresholdPct: 100 });
    await linkTestQueue(sql, team, Q1);
    await applySnapshot(snapshot([{ queueId: Q1, members: [m("a@bigthinkcapital.com")] }]));
    const res = await applySnapshot(snapshot([{ queueId: Q1, members: [] }]));
    expect(res.teams[0]).toMatchObject({ status: "blocked", reason: "empty_queue" });
    expect(await statusOf(team)).toEqual({ "a@bigthinkcapital.com": "pending_onboarding" });
  });

  it("an admin approval lets the next blocked snapshot apply once", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const four = ["a", "b", "c", "d"].map((e) => m(`${e}@bigthinkcapital.com`));
    await applySnapshot(snapshot([{ queueId: Q1, members: four }]));
    await applySnapshot(snapshot([{ queueId: Q1, members: four.slice(0, 1) }]));
    const [alert] = await sql`select id from app.sync_alerts`;
    await resolveAlert({ id: admin.id, role: "admin" }, alert.id, { approveMassRemoval: true });
    const res = await applySnapshot(snapshot([{ queueId: Q1, members: four.slice(0, 1) }]));
    expect(res.teams[0]).toMatchObject({ status: "applied", counts: { removals: 3 } });
    const [t] = await sql`select sync_health, mass_removal_approved_until from app.teams where id = ${team}`;
    expect(t).toMatchObject({ sync_health: "ok", mass_removal_approved_until: null });
  });

  it("enqueues reassignment only when removal_policy is reassign", async () => {
    const keep = await makeTeam(sql, { removalPolicy: "keep_bookings" });
    const reassign = await makeTeam(sql, { removalPolicy: "reassign" });
    await linkTestQueue(sql, keep, Q1);
    await linkTestQueue(sql, reassign, Q2);
    const host = await makeUser(sql, { email: "host@bigthinkcapital.com" });
    const others = ["o1", "o2", "o3"].map((e) => m(`${e}@bigthinkcapital.com`));
    await applySnapshot(
      snapshot([
        { queueId: Q1, members: [m("host@bigthinkcapital.com"), ...others] },
        { queueId: Q2, members: [m("host@bigthinkcapital.com"), ...others] },
      ]),
    );
    const future = await teamBooking(reassign, host.id, 48);
    await teamBooking(reassign, host.id, -48); // past
    await teamBooking(reassign, host.id, 72, "cancelled");
    await teamBooking(keep, host.id, 96);

    const res = await applySnapshot(snapshot([{ queueId: Q1, members: others }, { queueId: Q2, members: others }]));
    expect(res.teams.find((t) => t.teamId === reassign)).toMatchObject({ status: "applied", reassignJobs: 1 });
    expect(res.teams.find((t) => t.teamId === keep)).toMatchObject({ status: "applied", reassignJobs: 0 });
    const jobs = await sql`select payload, booking_id from app.jobs where kind = 'booking_reassign'`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ bookingId: future, fromUserId: host.id, reason: "removed_from_queue" });
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/sync/queue-snapshot", () => {
  const url = `${BASE}/api/sync/queue-snapshot`;

  it("accepts a valid signed snapshot and returns a per-team summary", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const res = await snapshotPOST(signedPost(url, snapshot([{ queueId: Q1, members: [m("a@bigthinkcapital.com")] }])));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, teams: [{ teamId: team, status: "applied", events: 1 }], rejectedQueueIds: [] });
    expect(JSON.stringify(body)).not.toContain("@");
  });

  it("rejects a bad signature, a stale timestamp, a missing nonce, and a replayed nonce", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const body = snapshot([{ queueId: Q1, members: [] }]);
    expect((await snapshotPOST(signedPost(url, body, { secret: "wrong" }))).status).toBe(401);
    expect((await snapshotPOST(signedPost(url, body, { ts: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    expect((await snapshotPOST(new Request(url, { method: "POST", body: JSON.stringify(body) }))).status).toBe(401);
    expect((await snapshotPOST(signedPost(url, body, { nonce: null }))).status).toBe(400);
    expect((await snapshotPOST(signedPost(url, body, { nonce: "n-1" }))).status).toBe(200);
    expect((await snapshotPOST(signedPost(url, body, { nonce: "n-1" }))).status).toBe(409);
  });

  it("rejects invalid bodies and oversized payloads", async () => {
    expect((await snapshotPOST(signedPost(url, { snapshotId: "x", queues: [] }))).status).toBe(400);
    const raw = "x".repeat(2 * 1024 * 1024 + 1);
    const req = new Request(url, { method: "POST", headers: signedHeaders(raw), body: raw });
    expect((await snapshotPOST(req)).status).toBe(413);
  });

  it("rejects unlinked queues", async () => {
    const res = await snapshotPOST(signedPost(url, snapshot([{ queueId: Q_UNLINKED, members: [m("a@bigthinkcapital.com")] }])));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "unlinked_queues", rejectedQueueIds: [Q_UNLINKED] });

    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const mixed = await snapshotPOST(
      signedPost(url, snapshot([{ queueId: Q1, members: [] }, { queueId: Q_UNLINKED, members: [m("x@bigthinkcapital.com")] }])),
    );
    expect(mixed.status).toBe(200);
    expect(await mixed.json()).toMatchObject({ rejectedQueueIds: [Q_UNLINKED] });
    expect(await count("select count(*) as n from app.team_members")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/sync/queue-membership", () => {
  const url = `${BASE}/api/sync/queue-membership`;
  const push = (over: Record<string, unknown> = {}) => ({
    eventId: `evt-${Math.random().toString(36).slice(2, 12)}`,
    timestamp: new Date().toISOString(),
    action: "added",
    queueId: Q1,
    sfUserId: sfUserId(),
    email: "pushed@bigthinkcapital.com",
    ...over,
  });
  const bearerReq = (body: unknown, token = PUSH_BEARER) =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("applies an add and a remove via the bearer path", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    await makeUser(sql, { email: "pushed@bigthinkcapital.com" });
    const add = await pushPOST(bearerReq(push()));
    expect(add.status).toBe(200);
    expect(await statusOf(team)).toEqual({ "pushed@bigthinkcapital.com": "active" });

    const remove = await pushPOST(bearerReq(push({ action: "removed" })));
    expect(remove.status).toBe(200);
    expect(await statusOf(team)).toEqual({ "pushed@bigthinkcapital.com": "paused" });
    const evs = await sql`select source, new_status from app.membership_events order by created_at`;
    expect(evs.map((e) => [e.source, e.new_status])).toEqual([
      ["push", "active"],
      ["push", "paused"],
    ]);
    expect(await count("select count(*) as n from app.jobs where kind = 'slack_membership_sync'")).toBe(2);
  });

  it("removal is not subject to the safety rail but keeps people still in another linked queue", async () => {
    const team = await makeTeam(sql, { thresholdPct: 1 });
    await linkTestQueue(sql, team, Q1);
    await linkTestQueue(sql, team, Q2);
    await applySnapshot(
      snapshot([
        { queueId: Q1, members: [m("solo@bigthinkcapital.com"), m("both@bigthinkcapital.com")] },
        { queueId: Q2, members: [m("both@bigthinkcapital.com")] },
      ]),
    );
    await pushPOST(bearerReq(push({ action: "removed", email: "SOLO@bigthinkcapital.com" })));
    await pushPOST(bearerReq(push({ action: "removed", email: "both@bigthinkcapital.com" })));
    expect(await statusOf(team)).toEqual({ "both@bigthinkcapital.com": "pending_onboarding", "solo@bigthinkcapital.com": "paused" });
    expect(await count("select count(*) as n from app.sync_alerts")).toBe(0);
  });

  it("accepts HMAC-signed pushes and rejects bad credentials, stale timestamps and replays", async () => {
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const body = push();
    expect((await pushPOST(bearerReq(body, "wrong-token"))).status).toBe(401);
    expect((await pushPOST(signedPost(url, body, { secret: "wrong" }))).status).toBe(401);
    expect((await pushPOST(bearerReq(push({ timestamp: new Date(Date.now() - 10 * 60_000).toISOString() })))).status).toBe(401);
    expect((await pushPOST(signedPost(url, body))).status).toBe(200);
    expect((await pushPOST(bearerReq(body))).status).toBe(409);
    expect((await pushPOST(bearerReq(push({ action: "moved" })))).status).toBe(400);
  });

  it("ignores pushes for unlinked queues", async () => {
    const res = await pushPOST(bearerReq(push({ queueId: Q_UNLINKED })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(await count("select count(*) as n from app.team_members")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/sync/linked-queues", () => {
  it("returns queue ids for queue-driven teams, signed over an empty body", async () => {
    const team = await makeTeam(sql);
    const manual = await makeTeam(sql, { membershipSource: "manual" });
    await linkTestQueue(sql, team, Q1);
    await linkTestQueue(sql, team, Q2);
    await linkTestQueue(sql, manual, Q_UNLINKED);
    const url = `${BASE}/api/sync/linked-queues`;
    const ok = await linkedGET(new Request(url, { headers: signedHeaders("") }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ queueIds: [Q2, Q1].sort() });
    expect((await linkedGET(new Request(url))).status).toBe(401);
    const ts = String(Math.floor(Date.now() / 1000));
    const bad = { "x-btc-timestamp": ts, "x-btc-signature": computeSignature(SYNC_SECRET, ts, "x") };
    expect((await linkedGET(new Request(url, { headers: bad }))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("queue sync health cron", () => {
  it("requires the cron secret", async () => {
    expect((await healthGET(new Request(`${BASE}/api/cron/queue-sync-health`))).status).toBe(401);
    const res = await healthGET(
      new Request(`${BASE}/api/cron/queue-sync-health`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }),
    );
    expect(res.status).toBe(200);
  });

  it("marks stale teams, alerts once per episode, and a good sync resolves it", async () => {
    const team = await makeTeam(sql);
    const fresh = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    await linkTestQueue(sql, fresh, Q2);
    await applySnapshot(snapshot([{ queueId: Q1, members: [] }, { queueId: Q2, members: [] }]));
    await sql`update app.teams set last_synced_at = now() - interval '30 minutes' where id = ${team}`;
    await sql`update app.team_sf_queues set last_snapshot_at = now() - interval '30 minutes' where team_id = ${team}`;

    const r1 = await checkQueueSyncHealth(10);
    expect(r1).toMatchObject({ markedStale: [team], alertsRaised: 1 });
    const r2 = await checkQueueSyncHealth(10);
    expect(r2.alertsRaised).toBe(0);
    expect(await count("select count(*) as n from app.sync_alerts where kind = 'sync_stale' and resolved_at is null")).toBe(1);
    const [t] = await sql`select sync_health from app.teams where id = ${team}`;
    expect(t.sync_health).toBe("stale");

    await applySnapshot(snapshot([{ queueId: Q1, members: [] }]));
    expect(await count("select count(*) as n from app.sync_alerts where kind = 'sync_stale' and resolved_at is null")).toBe(0);
    const [t2] = await sql`select sync_health from app.teams where id = ${team}`;
    expect(t2.sync_health).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
describe("admin functions", () => {
  async function actors() {
    const admin = await makeUser(sql, { role: "admin" });
    const user = await makeUser(sql);
    return { admin: { id: admin.id, role: "admin" as const }, user: { id: user.id, role: "user" as const } };
  }

  it("link and unlink queues with audit; non-admins are denied", async () => {
    const { admin, user } = await actors();
    const team = await makeTeam(sql);
    await expect(linkQueue(user, team, Q1)).rejects.toMatchObject({ code: "forbidden" });
    await expect(linkQueue(admin, team, "not-a-queue")).rejects.toMatchObject({ code: "invalid" });
    const linked = await linkQueue(admin, team, "00GVy00000TRvHd", "SDR Round Robin");
    expect(linked.queueId).toBe(Q1);
    await expect(linkQueue(admin, team, Q1)).rejects.toMatchObject({ code: "conflict" });
    await expect(unlinkQueue(user, team, Q1)).rejects.toBeInstanceOf(SyncAdminError);
    await unlinkQueue(admin, team, Q1);
    await expect(unlinkQueue(admin, team, Q1)).rejects.toMatchObject({ code: "not_found" });
    const audit = await sql`select action, actor_user_id from app.audit_log where entity_id = ${team} order by created_at`;
    expect(audit.map((a) => a.action)).toEqual(["team.sf_queue.link", "team.sf_queue.unlink"]);
    expect(audit.every((a) => a.actor_user_id === admin.id)).toBe(true);
  });

  it("RLS denies a non-admin writing team_sf_queues directly", async () => {
    const { user } = await actors();
    const team = await makeTeam(sql);
    const { withUser } = await import("@/server/db/client");
    await expect(
      withUser(user.id, (tx) => tx`insert into app.team_sf_queues (team_id, queue_id) values (${team}, ${Q1})`),
    ).rejects.toThrow(/row-level security/);
  });

  it("updates team sync settings with before/after audit", async () => {
    const { admin, user } = await actors();
    const team = await makeTeam(sql, { membershipSource: "manual" });
    await expect(setTeamSyncSettings(user, team, { removalPolicy: "reassign" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setTeamSyncSettings(admin, team, { massRemovalThresholdPct: 0 })).rejects.toMatchObject({ code: "invalid" });
    const after = await setTeamSyncSettings(admin, team, { membershipSource: "salesforce_queue", massRemovalThresholdPct: 30 });
    expect(after).toEqual({ membershipSource: "salesforce_queue", removalPolicy: "keep_bookings", massRemovalThresholdPct: 30 });
    const [a] = await sql`select before, after from app.audit_log where action = 'team.sync_settings.update'`;
    expect(a.before.membershipSource).toBe("manual");
    expect(a.after.massRemovalThresholdPct).toBe(30);
  });

  it("resolves alerts (admin only)", async () => {
    const { admin, user } = await actors();
    const team = await makeTeam(sql);
    const [alert] = await sql`insert into app.sync_alerts (team_id, kind) values (${team}, 'sync_stale') returning id`;
    await expect(resolveAlert(user, alert.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await resolveAlert(admin, alert.id, { approveMassRemoval: true })).toMatchObject({ kind: "sync_stale", approved: false });
    await expect(resolveAlert(admin, alert.id)).rejects.toMatchObject({ code: "not_found" });
    const [row] = await sql`select resolved_by from app.sync_alerts where id = ${alert.id}`;
    expect(row.resolved_by).toBe(admin.id);
    expect(await count("select count(*) as n from app.audit_log where action = 'sync_alert.resolve'")).toBe(1);
  });

  it("manual member override writes an admin event, a Slack job and an audit entry; sync respects it", async () => {
    const { admin, user } = await actors();
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    await applySnapshot(snapshot([{ queueId: Q1, members: [m("rep@bigthinkcapital.com")] }]));
    const [tm] = await members(team);
    await expect(manualMemberOverride(user, tm.id, "paused")).rejects.toMatchObject({ code: "forbidden" });

    const res = await manualMemberOverride(admin, tm.id, "paused", "on leave");
    expect(res.changed).toBe(true);
    const [ev] = await sql`select source, actor_user_id, old_status, new_status from app.membership_events where id = ${res.membershipEventId}`;
    expect(ev).toMatchObject({ source: "admin", actor_user_id: admin.id, old_status: "pending_onboarding", new_status: "paused" });
    const [job] = await sql`select payload from app.jobs where idempotency_key = ${"membership_event:" + res.membershipEventId}`;
    expect(job.payload).toEqual({ teamId: team, teamMemberId: tm.id });
    expect(await count("select count(*) as n from app.audit_log where action = 'team_member.status_override'")).toBe(1);

    await applySnapshot(snapshot([{ queueId: Q1, members: [m("rep@bigthinkcapital.com")] }]));
    expect(await statusOf(team)).toEqual({ "rep@bigthinkcapital.com": "paused" });
    expect((await manualMemberOverride(admin, tm.id, "paused")).changed).toBe(false);
  });

  it("requestSyncNow posts a signed request to n8n", async () => {
    const { admin, user } = await actors();
    const team = await makeTeam(sql);
    await linkTestQueue(sql, team, Q1);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await requestSyncNow(admin, team, { fetch: fetchMock as unknown as typeof fetch })).toEqual({ ok: true });
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://api.bigthinkcapital.com/webhook/btc-scheduler/queue-sync-now");
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(headers["x-btc-signature"]).toBe(computeSignature(process.env.N8N_SIGNING_SECRET!, headers["x-btc-timestamp"], body));
    expect(JSON.parse(body)).toMatchObject({ teamId: team, queueIds: [Q1] });

    const failing = vi.fn(async () => new Response("no", { status: 502 }));
    expect(await requestSyncNow(admin, team, { fetch: failing as unknown as typeof fetch })).toEqual({ ok: false, error: "http_502" });
    const throwing = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await requestSyncNow(admin, team, { fetch: throwing as unknown as typeof fetch })).toEqual({ ok: false, error: "network_error" });
    await expect(requestSyncNow(user, team, { fetch: fetchMock as unknown as typeof fetch })).rejects.toMatchObject({ code: "forbidden" });
  });
});
