import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { createFakeSlack, type FakeSlack } from "../helpers/slack-fake";
import { withUser, type Sql } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { runJobs } from "@/server/jobs/worker";
import { createSlackClient, type SlackClient } from "@/server/slack/client";
import { createSlackHandlers } from "@/server/slack/jobs";
import { IDENTITY_TTL_DAYS } from "@/server/slack/sync";
import {
  addChannel,
  checkChannelHealth,
  fullResync,
  previewChannel,
  removeChannel,
  setDryRun,
  updateChannel,
  SlackAdminError,
} from "@/server/slack/admin";

let sql: Sql;
let fake: FakeSlack;
let client: SlackClient;

beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  fake = createFakeSlack();
  client = createSlackClient({ token: "xoxb-test-token", fetch: fake.fetch });
});

const handlers = (adminNotifyChannel: string | null = null) =>
  createSlackHandlers({ client: () => client, options: { adminNotifyChannel } });

async function makeTeam(name = "SDR Round Robin") {
  const [t] = await sql<{ id: string }[]>`
    insert into app.teams (name, slug) values (${name}, ${"t-" + Math.random().toString(36).slice(2, 10)}) returning id`;
  return t.id;
}

async function makeMember(teamId: string, status: "active" | "paused" | "pending_onboarding", slackId: string | null) {
  const u = await makeUser(sql);
  if (slackId) fake.users.set(u.email.toLowerCase(), slackId);
  const [m] = await sql<{ id: string }[]>`
    insert into app.team_members (team_id, user_id, email, status, source)
    values (${teamId}, ${u.id}, ${u.email}, ${status}, 'queue') returning id`;
  return { id: m.id, userId: u.id, email: u.email };
}

async function makeConfig(
  teamId: string,
  channelId: string,
  over: Partial<{ mode: "add_only" | "add_and_remove"; dryRun: boolean; protectedIds: string[]; notify: string | null }> = {},
) {
  const [c] = await sql<{ id: string }[]>`
    insert into app.team_slack_channels (team_id, channel_id, mode, dry_run, protected_slack_user_ids, notify_channel_id)
    values (${teamId}, ${channelId}, ${over.mode ?? "add_and_remove"}, ${over.dryRun ?? false},
            ${over.protectedIds ?? []}, ${over.notify ?? null})
    returning id`;
  return c.id;
}

async function sync(teamId: string, teamMemberId: string, notify: string | null = null) {
  await enqueue(sql, {
    kind: "slack_membership_sync",
    payload: { teamId, teamMemberId },
    idempotencyKey: `t:${teamMemberId}:${Math.random()}`,
    teamId,
  });
  return runJobs(handlers(notify), { sql, deadlineMs: 5000 });
}

const actionsFor = (memberId: string) =>
  sql`select action, outcome, dry_run, error_code, detail, channel_id from app.slack_channel_actions
      where team_member_id = ${memberId} order by created_at`;
const health = async (configId: string) =>
  (await sql`select health, last_error, last_checked_at from app.team_slack_channels where id = ${configId}`)[0];

describe("slack_membership_sync", () => {
  it("invites an active member and kicks a paused one (happy path)", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000001" });
    const cfg = await makeConfig(team, "C1000001");
    const active = await makeMember(team, "active", "UACT00001");
    const paused = await makeMember(team, "paused", "UPAU00001");
    ch.members.add("UPAU00001");

    expect(await sync(team, active.id)).toMatchObject({ succeeded: 1 });
    expect(await sync(team, paused.id)).toMatchObject({ succeeded: 1 });

    expect(ch.members.has("UACT00001")).toBe(true);
    expect(ch.members.has("UPAU00001")).toBe(false);
    expect(await actionsFor(active.id)).toMatchObject([{ action: "invite", outcome: "done", dry_run: false }]);
    expect(await actionsFor(paused.id)).toMatchObject([{ action: "kick", outcome: "done" }]);
    expect(await health(cfg)).toMatchObject({ health: "ok", last_error: null });
    // The token is only ever in the Authorization header.
    expect(fake.calls.every((c) => !JSON.stringify(c.args).includes("xoxb"))).toBe(true);
  });

  it("uses the member's current status, not the status at enqueue time", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000002" });
    await makeConfig(team, "C1000002");
    const m = await makeMember(team, "active", "UCUR00001");
    await enqueue(sql, { kind: "slack_membership_sync", payload: { teamId: team, teamMemberId: m.id }, idempotencyKey: "x1" });
    await sql`update app.team_members set status = 'paused' where id = ${m.id}`;
    await runJobs(handlers(), { sql, deadlineMs: 5000 });
    expect(fake.callsTo("conversations.invite")).toHaveLength(0);
    expect(ch.members.has("UCUR00001")).toBe(false);
  });

  it("treats already_in_channel and not_in_channel as success", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000003" });
    await makeConfig(team, "C1000003");
    const a = await makeMember(team, "active", "UIDE00001");
    ch.members.add("UIDE00001");
    const p = await makeMember(team, "paused", "UIDE00002"); // not in channel

    expect(await sync(team, a.id)).toMatchObject({ succeeded: 1 });
    expect(await sync(team, p.id)).toMatchObject({ succeeded: 1 });
    expect(await actionsFor(a.id)).toMatchObject([{ action: "invite", outcome: "done", detail: "Already in the desired state" }]);
    expect(await actionsFor(p.id)).toMatchObject([{ action: "kick", outcome: "done", detail: "Already in the desired state" }]);
    // The kick's not_in_channel was confirmed against conversations.info (bot is a member).
    expect(fake.callsTo("conversations.info")).toHaveLength(1);
    expect(fake.callsTo("conversations.join")).toHaveLength(0);
  });

  it("add_only never removes; pending members are not invited", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000004" });
    await makeConfig(team, "C1000004", { mode: "add_only" });
    const p = await makeMember(team, "paused", "UADD00001");
    ch.members.add("UADD00001");
    const pending = await makeMember(team, "pending_onboarding", "UADD00002");
    await sync(team, p.id);
    await sync(team, pending.id);
    expect(ch.members.has("UADD00001")).toBe(true);
    expect(ch.members.has("UADD00002")).toBe(false);
    expect(fake.calls.filter((c) => c.method.startsWith("conversations."))).toHaveLength(0);
    // No identity lookups are made when no action is needed.
    expect(fake.callsTo("users.lookupByEmail")).toHaveLength(0);
  });

  it("never kicks protected users and skips #general and the bot itself", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000005" });
    const gen = fake.addChannel({ id: "C1000006", is_general: true });
    await makeConfig(team, "C1000005", { protectedIds: ["UPRO00001"] });
    await makeConfig(team, "C1000006");
    const prot = await makeMember(team, "paused", "UPRO00001");
    ch.members.add("UPRO00001");
    gen.members.add("UPRO00001");
    await sync(team, prot.id);
    expect(ch.members.has("UPRO00001")).toBe(true);
    const rows = await actionsFor(prot.id);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel_id: "C1000005", action: "skip", outcome: "skipped", error_code: "protected_user" }),
        expect.objectContaining({ channel_id: "C1000006", action: "skip", outcome: "skipped", error_code: "cant_kick_from_general" }),
      ]),
    );
    expect(fake.callsTo("conversations.kick").map((c) => c.args.channel)).toEqual(["C1000006"]);
  });

  it("marks a private channel bot_not_in_channel with /invite instructions", async () => {
    const team = await makeTeam();
    fake.addChannel({ id: "G1000007", is_private: true, bot: false });
    const cfg = await makeConfig(team, "G1000007");
    const m = await makeMember(team, "active", "UPRI00001");
    expect(await sync(team, m.id)).toMatchObject({ succeeded: 1 });
    const h = await health(cfg);
    expect(h.health).toBe("bot_not_in_channel");
    expect(h.last_error).toContain("/invite @BTC Scheduler");
    expect(await actionsFor(m.id)).toMatchObject([{ action: "invite", outcome: "error", error_code: "channel_not_found" }]);
    expect(fake.callsTo("conversations.join")).toHaveLength(0);
  });

  it("maps not_in_channel on a private channel (bot removed later) to bot_not_in_channel", async () => {
    const team = await makeTeam();
    fake.addChannel({ id: "C1000008", is_private: true, bot: true });
    const cfg = await makeConfig(team, "C1000008");
    const m = await makeMember(team, "active", "UPRI00002");
    fake.force("conversations.invite", { body: { ok: false, error: "not_in_channel" } });
    fake.force("conversations.info", { body: { ok: true, channel: { id: "C1000008", name: "x", is_private: true, is_member: false, is_archived: false, is_general: false } } });
    await sync(team, m.id);
    expect((await health(cfg)).health).toBe("bot_not_in_channel");
    expect(fake.callsTo("conversations.join")).toHaveLength(0);
  });

  it("joins a public channel and retries the invite once", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000009", bot: false });
    const cfg = await makeConfig(team, "C1000009");
    const m = await makeMember(team, "active", "UPUB00001");
    expect(await sync(team, m.id)).toMatchObject({ succeeded: 1 });
    expect(fake.calls.map((c) => c.method)).toEqual([
      "users.lookupByEmail",
      "conversations.invite",
      "conversations.info",
      "conversations.join",
      "conversations.invite",
    ]);
    expect(ch.members.has("UPUB00001")).toBe(true);
    expect((await health(cfg)).health).toBe("ok");
  });

  it("surfaces restricted_action on kick as a channel error with the runbook link", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000010" });
    const cfg = await makeConfig(team, "C1000010");
    const m = await makeMember(team, "paused", "URES00001");
    ch.members.add("URES00001");
    fake.settings.restrictKicks = true;
    expect(await sync(team, m.id)).toMatchObject({ succeeded: 1 });
    const h = await health(cfg);
    expect(h.health).toBe("error");
    expect(h.last_error).toContain("block removals by apps");
    expect(h.last_error).toContain("docs/runbook.md#slack-removals-blocked");
    expect(await actionsFor(m.id)).toMatchObject([{ action: "kick", outcome: "error", error_code: "restricted_action" }]);

    // A later successful invite does not hide the removals problem.
    const a = await makeMember(team, "active", "URES00002");
    await sync(team, a.id);
    expect(ch.members.has("URES00002")).toBe(true);
    expect((await health(cfg)).health).toBe("error");
  });

  it("reschedules on rate limit with Retry-After and succeeds on the next run", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000011" });
    await makeConfig(team, "C1000011");
    const m = await makeMember(team, "active", "URAT00001");
    fake.force("conversations.invite", { status: 429, headers: { "retry-after": "42" }, body: { ok: false, error: "ratelimited" } });

    expect(await sync(team, m.id)).toMatchObject({ retried: 1, succeeded: 0 });
    const [job] = await sql`
      select status, attempts, last_error, extract(epoch from (run_at - now()))::int as wait
      from app.jobs where kind = 'slack_membership_sync'`;
    expect(job.status).toBe("failed");
    expect(job.wait).toBeGreaterThanOrEqual(38);
    expect(job.wait).toBeLessThanOrEqual(42);
    expect(job.last_error).toMatch(/rate limited/);

    await sql`update app.jobs set run_at = now() where kind = 'slack_membership_sync'`;
    expect(await runJobs(handlers(), { sql, deadlineMs: 5000 })).toMatchObject({ succeeded: 1 });
    expect(ch.members.has("URAT00001")).toBe(true);
  });

  it("fails permanently and marks every channel on invalid_auth or missing_scope", async () => {
    const team = await makeTeam();
    fake.addChannel({ id: "C1000012" });
    fake.addChannel({ id: "C1000013" });
    const c1 = await makeConfig(team, "C1000012");
    const c2 = await makeConfig(team, "C1000013");
    const m = await makeMember(team, "active", "UAUT00001");
    fake.force("users.lookupByEmail", { body: { ok: false, error: "invalid_auth" } });
    expect(await sync(team, m.id)).toMatchObject({ dead: 1 });
    expect((await health(c1)).health).toBe("error");
    expect((await health(c2)).last_error).toContain("invalid or revoked");

    const m2 = await makeMember(team, "active", "UAUT00002");
    fake.force("conversations.invite", { body: { ok: false, error: "missing_scope" } });
    expect(await sync(team, m2.id)).toMatchObject({ dead: 1 });
    const [job] = await sql`select status, last_error from app.jobs where payload->>'teamMemberId' = ${m2.id}`;
    expect(job).toMatchObject({ status: "dead" });
    expect(job.last_error).toContain("missing a required scope");
  });

  it("caches users.lookupByEmail and refreshes after 30 days", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000014" });
    await makeConfig(team, "C1000014");
    const m = await makeMember(team, "active", "UCAC00001");
    await sync(team, m.id);
    await sync(team, m.id);
    expect(fake.callsTo("users.lookupByEmail")).toHaveLength(1);
    const [cached] = await sql`select slack_user_id from app.slack_identities where user_id = ${m.userId}`;
    expect(cached.slack_user_id).toBe("UCAC00001");

    await sql`update app.slack_identities set resolved_at = now() - make_interval(days => ${IDENTITY_TTL_DAYS + 1})`;
    fake.users.set(m.email.toLowerCase(), "UCAC00002");
    await sync(team, m.id);
    expect(fake.callsTo("users.lookupByEmail")).toHaveLength(2);
    expect(ch.members.has("UCAC00002")).toBe(true);
    const [fresh] = await sql`select slack_user_id from app.slack_identities where user_id = ${m.userId}`;
    expect(fresh.slack_user_id).toBe("UCAC00002");
  });

  it("records a warning, not a retry, when the email has no Slack account", async () => {
    const team = await makeTeam();
    fake.addChannel({ id: "C1000015" });
    await makeConfig(team, "C1000015");
    const m = await makeMember(team, "active", null);
    expect(await sync(team, m.id)).toMatchObject({ succeeded: 1, retried: 0 });
    expect(await actionsFor(m.id)).toMatchObject([{ action: "skip", outcome: "skipped", error_code: "users_not_found" }]);
    expect(fake.callsTo("conversations.invite")).toHaveLength(0);
  });

  it("dry run records would_do and makes no invite or kick calls", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000016" });
    await makeConfig(team, "C1000016", { dryRun: true });
    const a = await makeMember(team, "active", "UDRY00001");
    const p = await makeMember(team, "paused", "UDRY00002");
    ch.members.add("UDRY00002");
    await sync(team, a.id, "C9999999");
    await sync(team, p.id, "C9999999");
    expect(await actionsFor(a.id)).toMatchObject([{ action: "invite", outcome: "would_do", dry_run: true }]);
    expect(await actionsFor(p.id)).toMatchObject([{ action: "kick", outcome: "would_do", dry_run: true }]);
    expect(fake.calls.map((c) => c.method).filter((x) => x !== "users.lookupByEmail")).toEqual([]);
    expect(ch.members.has("UDRY00001")).toBe(false);
    expect(ch.members.has("UDRY00002")).toBe(true);
  });

  it("posts an admin notice on a real change, and a failed notice does not fail the job", async () => {
    const team = await makeTeam("House Book");
    fake.addChannel({ id: "C1000017" });
    await makeConfig(team, "C1000017", { notify: "C2000001" });
    const m = await makeMember(team, "active", "UNOT00001");
    await sql`insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source)
              values (${team}, ${m.id}, ${m.email}, 'paused', 'active', 'poll')`;
    await sync(team, m.id);
    const posts = fake.callsTo("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].args).toMatchObject({
      channel: "C2000001",
      text: "BTC Scheduler added <@UNOT00001> to <#C1000017> (team: House Book, reason: queue sync)",
    });

    // Idempotent re-run: no change, so no notice.
    await sync(team, m.id);
    expect(fake.callsTo("chat.postMessage")).toHaveLength(1);

    // Notice failures (Slack error, rate limit, network) never fail the job.
    const m2 = await makeMember(team, "active", "UNOT00002");
    fake.settings.postMessageError = "not_in_channel";
    expect(await sync(team, m2.id)).toMatchObject({ succeeded: 1 });
    const m3 = await makeMember(team, "active", "UNOT00003");
    fake.force("chat.postMessage", { status: 429, headers: { "retry-after": "5" }, body: { ok: false, error: "ratelimited" } });
    expect(await sync(team, m3.id)).toMatchObject({ succeeded: 1 });
    const m4 = await makeMember(team, "active", "UNOT00004");
    fake.force("chat.postMessage", {});
    expect(await sync(team, m4.id)).toMatchObject({ succeeded: 1 });
    const [job] = await sql`select result from app.jobs where payload->>'teamMemberId' = ${m2.id}`;
    expect(job.result.actions[0]).toMatchObject({ outcome: "done", noticePosted: false, noticeError: "not_in_channel" });
  });

  it("falls back to SLACK_ADMIN_NOTIFY_CHANNEL when the channel has no notice channel", async () => {
    const team = await makeTeam();
    fake.addChannel({ id: "C1000018" });
    await makeConfig(team, "C1000018");
    const m = await makeMember(team, "active", "UFAL00001");
    await sync(team, m.id, "C3000001");
    expect(fake.callsTo("chat.postMessage")[0].args.channel).toBe("C3000001");
  });

  it("kicks a member whose team row was deleted, using the cached identity", async () => {
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C1000019" });
    await makeConfig(team, "C1000019");
    const m = await makeMember(team, "active", "UDEL00001");
    await sync(team, m.id);
    expect(ch.members.has("UDEL00001")).toBe(true);
    await sql`insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, detail)
              values (${team}, ${m.id}, ${m.email}, 'active', null, 'admin', ${sql.json({ team_member_id: m.id })})`;
    await sql`delete from app.team_members where id = ${m.id}`;
    expect(await sync(team, m.id)).toMatchObject({ succeeded: 1 });
    expect(ch.members.has("UDEL00001")).toBe(false);
    const [row] = await sql`select action, outcome, team_member_id from app.slack_channel_actions where action = 'kick'`;
    expect(row).toMatchObject({ action: "kick", outcome: "done", team_member_id: null });
  });

  it("is a no-op for teams without channels and rejects bad payloads", async () => {
    const team = await makeTeam();
    const m = await makeMember(team, "active", "UNOP00001");
    expect(await sync(team, m.id)).toMatchObject({ succeeded: 1 });
    expect(fake.calls).toHaveLength(0);
    await enqueue(sql, { kind: "slack_membership_sync", payload: { teamId: "nope" }, idempotencyKey: "bad" });
    expect(await runJobs(handlers(), { sql, deadlineMs: 5000 })).toMatchObject({ dead: 1 });
  });
});

describe("slack admin functions", () => {
  async function admins() {
    const admin = await makeUser(sql, { role: "admin" });
    const user = await makeUser(sql);
    return { admin, user };
  }

  it("denies non-admins, including team admins", async () => {
    const { admin, user } = await admins();
    const team = await makeTeam();
    await sql`insert into app.team_admins (team_id, user_id) values (${team}, ${user.id})`;
    fake.addChannel({ id: "C4000001" });
    await expect(addChannel(user.id, team, { channelId: "C4000001" }, { client })).rejects.toMatchObject({ code: "forbidden" });
    const cfg = await addChannel(admin.id, team, { channelId: "C4000001" }, { client });
    for (const call of [
      () => setDryRun(user.id, cfg.id, false),
      () => updateChannel(user.id, cfg.id, { mode: "add_only" }),
      () => removeChannel(user.id, cfg.id),
      () => checkChannelHealth(user.id, cfg.id, { client }),
      () => previewChannel(user.id, cfg.id, { client }),
      () => fullResync(user.id, cfg.id),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(SlackAdminError);
    }
    // RLS also blocks a direct write by a non-admin.
    const updated = await withUser(user.id, (tx) => tx`update app.team_slack_channels set dry_run = false returning id`);
    expect(updated).toHaveLength(0);
    // Team admins can read the action log for their team.
    await sql`insert into app.slack_channel_actions (team_id, channel_config_id, channel_id, action, outcome)
              values (${team}, ${cfg.id}, 'C4000001', 'invite', 'would_do')`;
    expect(await withUser(user.id, (tx) => tx`select id from app.slack_channel_actions`)).toHaveLength(1);
    const outsider = await makeUser(sql);
    expect(await withUser(outsider.id, (tx) => tx`select id from app.slack_channel_actions`)).toHaveLength(0);
  });

  it("creates channels in dry run, verifies them, and audits every change", async () => {
    const { admin } = await admins();
    const team = await makeTeam();
    fake.addChannel({ id: "C4000002", name: "sdr-team" });
    const cfg = await addChannel(admin.id, team, { channelId: "C4000002", mode: "add_and_remove", protectedSlackUserIds: ["UMGR00001"] }, { client });
    expect(cfg).toMatchObject({ dry_run: true, channel_name: "sdr-team", health: "ok", mode: "add_and_remove" });

    await expect(addChannel(admin.id, team, { channelId: "C4000002" }, { client })).rejects.toMatchObject({ code: "duplicate" });
    await expect(addChannel(admin.id, team, { channelId: "#sdr-team" }, { client })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addChannel(admin.id, team, { channelId: "C4000003", protectedSlackUserIds: ["bob"] }, { client }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await setDryRun(admin.id, cfg.id, false);
    await updateChannel(admin.id, cfg.id, { notifyChannelId: "C5000001" });
    await removeChannel(admin.id, cfg.id);

    const audit = await sql`select action, before, after from app.audit_log where entity_id = ${cfg.id} order by created_at`;
    expect(audit.map((a) => a.action)).toEqual([
      "slack_channel.created",
      "slack_channel.dry_run_changed",
      "slack_channel.updated",
      "slack_channel.removed",
    ]);
    expect(audit[1]).toMatchObject({ before: { dry_run: true }, after: { dry_run: false } });
    expect(audit[2].after.notify_channel_id).toBe("C5000001");
  });

  it("records bot_not_in_channel for an unreachable private channel and re-checks health", async () => {
    const { admin } = await admins();
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "G4000004", is_private: true, bot: false, name: "closers" });
    const cfg = await addChannel(admin.id, team, { channelId: "G4000004" }, { client });
    expect(cfg).toMatchObject({ health: "bot_not_in_channel", channel_name: null });
    expect(cfg.last_error).toContain("/invite @BTC Scheduler");

    ch.bot = true;
    const after = await checkChannelHealth(admin.id, cfg.id, { client });
    expect(after).toMatchObject({ health: "ok", last_error: null, channel_name: "closers" });
  });

  it("previews would-add and would-remove lists without changing anything", async () => {
    const { admin } = await admins();
    const team = await makeTeam();
    const ch = fake.addChannel({ id: "C4000005" });
    const cfg = await addChannel(admin.id, team, { channelId: "C4000005", mode: "add_and_remove", protectedSlackUserIds: ["UPRV00003"] }, { client });
    const a = await makeMember(team, "active", "UPRV00001");
    const p = await makeMember(team, "paused", "UPRV00002");
    const prot = await makeMember(team, "paused", "UPRV00003");
    const missing = await makeMember(team, "active", null);
    await makeMember(team, "pending_onboarding", "UPRV00005");
    ch.members.add("UPRV00002").add("UPRV00003").add("UOUTSIDE1");
    const callsBefore = fake.calls.length;

    const preview = await previewChannel(admin.id, cfg.id, { client });
    expect(preview.wouldAdd.map((x) => x.teamMemberId)).toEqual([a.id]);
    expect(preview.wouldRemove.map((x) => x.teamMemberId)).toEqual([p.id]);
    expect(preview.protectedKept.map((x) => x.teamMemberId)).toEqual([prot.id]);
    expect(preview.unresolved.map((x) => x.teamMemberId)).toEqual([missing.id]);
    expect(preview.channelMemberCount).toBe(4);

    const methods = fake.calls.slice(callsBefore).map((c) => c.method);
    expect(methods.filter((x) => x === "conversations.members").length).toBeGreaterThan(1); // paginated
    expect(methods.some((x) => x === "conversations.invite" || x === "conversations.kick")).toBe(false);
    expect(await sql`select 1 from app.slack_channel_actions`).toHaveLength(0);
    expect(await sql`select 1 from app.slack_identities`).toHaveLength(0);
  });

  it("full resync enqueues one job per team member and audits", async () => {
    const { admin } = await admins();
    const team = await makeTeam();
    fake.addChannel({ id: "C4000006" });
    const cfg = await addChannel(admin.id, team, { channelId: "C4000006" }, { client });
    await makeMember(team, "active", "URSY00001");
    await makeMember(team, "paused", "URSY00002");
    expect(await fullResync(admin.id, cfg.id)).toEqual({ enqueued: 2 });
    expect(await fullResync(admin.id, cfg.id)).toEqual({ enqueued: 2 });
    const jobs = await sql`select payload from app.jobs where kind = 'slack_membership_sync'`;
    expect(jobs).toHaveLength(4);
    const audit = await sql`select action from app.audit_log where entity_id = ${cfg.id} and action = 'slack_channel.full_resync'`;
    expect(audit).toHaveLength(2);
    expect(await runJobs(handlers(), { sql, deadlineMs: 5000 })).toMatchObject({ succeeded: 4 });
  });
});
