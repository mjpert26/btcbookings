import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { createFakeSlack, type FakeSlack } from "../helpers/slack-fake";
import { makeTeam } from "../helpers/sync";
import type { Sql } from "@/server/db/client";
import { createSlackClient, type SlackClient } from "@/server/slack/client";
import { syncMemberUsergroup } from "@/server/slack/usergroup";
import { linkUsergroup } from "@/server/slack/usergroup-admin";

/**
 * The user group job reads its link again after it takes the per-group lock, and holds the
 * link row until it is done, so admin changes made while a job waits or runs are honoured.
 */

const USERGROUP = "S7000001";
const REP_SLACK_ID = "UREPX0001";
const OTHER = "UOTHER001";

let sql: Sql;
let slack: FakeSlack;

beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  slack = createFakeSlack();
});

async function setup(memberStatus: "active" | "paused" = "active") {
  const team = await makeTeam(sql);
  const rep = await makeUser(sql);
  slack.users.set(rep.email.toLowerCase(), REP_SLACK_ID);
  const [tm] = await sql<{ id: string }[]>`
    insert into app.team_members (team_id, user_id, email, status, source)
    values (${team}, ${rep.id}, ${rep.email}, ${memberStatus}, 'manual') returning id
  `;
  const [cfg] = await sql<{ id: string }[]>`
    insert into app.team_slack_usergroups (team_id, usergroup_id, mode, dry_run)
    values (${team}, ${USERGROUP}, 'add_and_remove', false) returning id
  `;
  slack.usergroups.set(USERGROUP, memberStatus === "active" ? [OTHER] : [OTHER, REP_SLACK_ID]);
  return { team, teamMemberId: tm.id, configId: cfg.id };
}

/** Holds the group's advisory lock, as a job already running on the group would. */
function holdGroupLock(): { held: Promise<void>; release: () => void; done: Promise<unknown> } {
  let release!: () => void;
  let markHeld!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = new Promise<void>((r) => (markHeld = r));
  const done = sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"slack-usergroup:" + USERGROUP}))`;
    markHeld();
    await gate;
  });
  return { held, release, done };
}

async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await sql<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted
    `;
    if (waiting >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never waited for the user group lock");
}

const updates = () => slack.callsTo("usergroups.users.update");

describe("user group sync reads its link under the lock", () => {
  it("uses dry run when it was turned on while the job waited for the lock", async () => {
    const f = await setup();
    const client = createSlackClient({ token: "xoxb-test-token", fetch: slack.fetch });
    const lock = holdGroupLock();
    await lock.held;
    const job = syncMemberUsergroup(sql, client, { teamId: f.team, teamMemberId: f.teamMemberId });
    await waitForLockWaiters(1);
    await sql`update app.team_slack_usergroups set dry_run = true where id = ${f.configId}`;
    lock.release();
    await lock.done;

    const out = await job;
    expect(out.action).toMatchObject({ action: "add", outcome: "would_do", dryRun: true });
    expect(updates()).toHaveLength(0);
    expect(slack.usergroups.get(USERGROUP)).toEqual([OTHER]);
  });

  it("uses add-only mode when it was switched while the job waited", async () => {
    const f = await setup("paused");
    const client = createSlackClient({ token: "xoxb-test-token", fetch: slack.fetch });
    const lock = holdGroupLock();
    await lock.held;
    const job = syncMemberUsergroup(sql, client, { teamId: f.team, teamMemberId: f.teamMemberId });
    await waitForLockWaiters(1);
    await sql`update app.team_slack_usergroups set mode = 'add_only' where id = ${f.configId}`;
    lock.release();
    await lock.done;

    const out = await job;
    expect(out.action).toBeNull();
    expect(updates()).toHaveLength(0);
    expect(slack.usergroups.get(USERGROUP)).toContain(REP_SLACK_ID);
  });

  it("does nothing when the group was unlinked while the job waited", async () => {
    const f = await setup();
    const client = createSlackClient({ token: "xoxb-test-token", fetch: slack.fetch });
    const lock = holdGroupLock();
    await lock.held;
    const job = syncMemberUsergroup(sql, client, { teamId: f.team, teamMemberId: f.teamMemberId });
    await waitForLockWaiters(1);
    await sql`delete from app.team_slack_usergroups where id = ${f.configId}`;
    lock.release();
    await lock.done;

    await expect(job).resolves.toMatchObject({ memberState: "no_usergroup", action: null });
    expect(slack.calls.filter((c) => c.method.startsWith("usergroups."))).toHaveLength(0);
    expect(await sql`select 1 from app.slack_usergroup_actions`).toHaveLength(0);
  });

  it("makes an unlink wait for a running job, so the job's action is still logged", async () => {
    const f = await setup();
    let unlink: Promise<unknown> | null = null;
    let unlinkSettledDuringWrite: boolean | null = null;
    const fetchWithHook = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/usergroups.users.update") && !unlink) {
        let settled = false;
        unlink = sql`delete from app.team_slack_usergroups where id = ${f.configId}`.then(() => (settled = true));
        await new Promise((r) => setTimeout(r, 150));
        unlinkSettledDuringWrite = settled;
      }
      return slack.fetch(url, init);
    }) as unknown as typeof fetch;
    const client: SlackClient = createSlackClient({ token: "xoxb-test-token", fetch: fetchWithHook });

    const out = await syncMemberUsergroup(sql, client, { teamId: f.team, teamMemberId: f.teamMemberId });
    expect(out.action).toMatchObject({ action: "add", outcome: "done" });
    expect(unlinkSettledDuringWrite).toBe(false);
    await unlink;
    expect(await sql`select 1 from app.team_slack_usergroups`).toHaveLength(0);
    // The action row survives the unlink (its link reference is cleared).
    const actions = await sql`select action, outcome, usergroup_config_id from app.slack_usergroup_actions`;
    expect(actions).toEqual([{ action: "add", outcome: "done", usergroup_config_id: null }]);
    expect(slack.usergroups.get(USERGROUP)).toEqual([OTHER, REP_SLACK_ID]);
  });
});

describe("one team per user group", () => {
  it("refuses to link a user group that another team already uses", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const client = createSlackClient({ token: "xoxb-test-token", fetch: slack.fetch });
    slack.usergroups.set(USERGROUP, [OTHER]);
    const teamA = await makeTeam(sql);
    const teamB = await makeTeam(sql);
    await linkUsergroup(admin.id, teamA, { usergroupId: USERGROUP }, { client });
    await expect(linkUsergroup(admin.id, teamB, { usergroupId: USERGROUP }, { client })).rejects.toMatchObject({
      code: "duplicate",
      message: "This Slack user group is already linked to another team",
    });
    await expect(sql`insert into app.team_slack_usergroups (team_id, usergroup_id) values (${teamB}, ${USERGROUP})`).rejects.toMatchObject({
      code: "23505",
    });
  });
});
