import "server-only";
import type { Db, Sql } from "@/server/db/client";
import { SLACK_CONFIG_ERRORS, type SlackClient } from "@/server/slack/client";
import { intendedAction, planUsergroupMember, type MemberState, type SlackMode } from "@/server/slack/plan";
import {
  SlackConfigError,
  SlackTransientError,
  checkRemovable,
  configErrorMessage,
  loadMember,
  resolveSlackUserId,
  type SyncOptions,
} from "@/server/slack/sync";

/**
 * Applies a team member's current status to the team's Slack user group, when one is linked
 * (app.team_slack_usergroups). Same direction as channels: Salesforce Queue -> team member
 * status -> Slack. Slack membership never changes team membership.
 *
 * usergroups.users.update replaces the whole member list, so each run reads the current list
 * with usergroups.users.list and adds or removes only this member, under an advisory lock per
 * user group so that two members' jobs cannot overwrite each other. A user group can be
 * linked to one team only (unique usergroup_id). Running a job twice leaves the group
 * unchanged and only appends to the action log.
 *
 * The link is read again after the lock is taken, so a job that waited behind another one
 * uses the current dry-run flag, mode and protected users, and stops if the link was removed.
 * The locking transaction also holds a key-share lock on the link row until the job is done,
 * so an unlink waits for a running job instead of removing the row it is about to log against.
 */

export type UsergroupRow = {
  id: string;
  team_id: string;
  usergroup_id: string;
  usergroup_handle: string | null;
  mode: SlackMode;
  dry_run: boolean;
  protected_slack_user_ids: string[];
  health: "unknown" | "ok" | "bot_not_in_channel" | "error";
};

export type UsergroupActionRecord = {
  action: "add" | "remove" | "skip";
  dryRun: boolean;
  outcome: "done" | "would_do" | "skipped" | "error";
  errorCode: string | null;
  detail: string | null;
  changed: boolean;
};

export type UsergroupSyncResult = {
  memberState: MemberState | "not_found" | "no_usergroup";
  slackUserId: string | null;
  usergroupId: string | null;
  action: UsergroupActionRecord | null;
};

/** Errors that mean the user group itself cannot be managed until someone fixes it. */
const GROUP_ERRORS: Record<string, string> = {
  no_such_subteam: "The Slack user group was not found. Check the user group id.",
  plan_upgrade_required: "This Slack workspace plan does not include user groups.",
  permission_denied:
    "Slack workspace settings do not let the app change this user group. A workspace admin must allow apps to manage user groups. See docs/slack-setup.md.",
  no_permission: "The app does not have permission to manage this user group.",
  access_denied: "Slack denied access to this user group.",
  subteam_max_users_exceeded: "The Slack user group has reached its maximum size.",
};

const TRANSIENT = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout", "invalid_response"]);
const isTransient = (code: string) => TRANSIENT.has(code) || code.startsWith("http_5");

export async function loadUsergroup(db: Db, teamId: string, opts: { keyShare?: boolean } = {}): Promise<UsergroupRow | null> {
  const [row] = await db<UsergroupRow[]>`
    select id, team_id, usergroup_id, usergroup_handle, mode, dry_run, protected_slack_user_ids, health
    from app.team_slack_usergroups where team_id = ${teamId}
    ${opts.keyShare ? db`for key share` : db``}
  `;
  return row ?? null;
}

async function recordAction(
  db: Db,
  cfg: UsergroupRow,
  teamMemberId: string | null,
  slackUserId: string | null,
  a: UsergroupActionRecord,
): Promise<void> {
  await db`
    insert into app.slack_usergroup_actions
      (team_id, usergroup_config_id, team_member_id, usergroup_id, slack_user_id, action, dry_run, outcome, error_code, detail)
    values (${cfg.team_id}, ${cfg.id}, ${teamMemberId}, ${cfg.usergroup_id}, ${slackUserId}, ${a.action}, ${a.dryRun},
            ${a.outcome}, ${a.errorCode}, ${a.detail})
  `;
}

async function setHealth(db: Db, id: string, health: UsergroupRow["health"], lastError: string | null): Promise<void> {
  await db`
    update app.team_slack_usergroups set health = ${health}, last_error = ${lastError}, last_checked_at = now()
    where id = ${id}
  `;
}

/** Maps an error from usergroups.users.list or update. Throws for credential and transient problems. */
function classify(code: string): { kind: "group"; message: string } | { kind: "member"; message: string } {
  if (SLACK_CONFIG_ERRORS.has(code)) throw new SlackConfigError(code);
  if (isTransient(code)) throw new SlackTransientError([code]);
  if (GROUP_ERRORS[code]) return { kind: "group", message: GROUP_ERRORS[code] };
  return { kind: "member", message: `Slack returned ${code}` };
}

/**
 * Throws RetryAfterError on rate limits (from the client), SlackConfigError on credential or
 * scope problems (after marking the user group unhealthy) and SlackTransientError on
 * transient Slack failures.
 */
export async function syncMemberUsergroup(
  sql: Sql,
  client: SlackClient,
  input: { teamId: string; teamMemberId: string },
  opts: SyncOptions = {},
): Promise<UsergroupSyncResult> {
  const noUsergroup: UsergroupSyncResult = { memberState: "no_usergroup", slackUserId: null, usergroupId: null, action: null };
  // The first read only picks the lock key. If the link was replaced by one for another
  // group while this job waited, take that group's lock and read again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen = await loadUsergroup(sql, input.teamId);
    if (!seen) return noUsergroup;
    const result = (await sql.begin(async (lockTx) => {
      await lockTx`select pg_advisory_xact_lock(hashtext(${"slack-usergroup:" + seen.usergroup_id}))`;
      // FOR KEY SHARE does not block the job's own health updates or action log inserts
      // (made on other connections), but makes an unlink wait until this transaction ends.
      const cfg = await loadUsergroup(lockTx, input.teamId, { keyShare: true });
      if (!cfg) return noUsergroup;
      if (cfg.usergroup_id !== seen.usergroup_id) return null;
      try {
        return await syncUnlocked(sql, client, cfg, input, opts);
      } catch (err) {
        if (err instanceof SlackConfigError) {
          const msg = configErrorMessage(err.code);
          await setHealth(sql, cfg.id, "error", msg);
        }
        throw err;
      }
    })) as UsergroupSyncResult | null;
    if (result) return result;
  }
  // The link changed twice while waiting; the job is retried later.
  throw new SlackTransientError(["usergroup_link_changed"]);
}

async function syncUnlocked(
  db: Sql,
  client: SlackClient,
  cfg: UsergroupRow,
  input: { teamId: string; teamMemberId: string },
  opts: SyncOptions,
): Promise<UsergroupSyncResult> {
  const member = await loadMember(db, input.teamId, input.teamMemberId);
  const base = { usergroupId: cfg.usergroup_id };
  if (!member) return { ...base, memberState: "not_found", slackUserId: null, action: null };
  const memberRef = member.state === "removed" ? null : member.teamMemberId;

  // Members that need no change (pending, or paused on an add-only group) cost no Slack calls.
  if (intendedAction(cfg.mode, member.state) === "none") return { ...base, memberState: member.state, slackUserId: null, action: null };

  const identity = await resolveSlackUserId(db, client, member, { now: opts.now?.() });
  const slackUserId = identity.slackUserId;

  const listed = await client.usergroupsUsersList(cfg.usergroup_id);
  if (!listed.ok || !listed.data) {
    const c = classify(listed.error ?? "unknown_error");
    const rec: UsergroupActionRecord = { action: "skip", dryRun: cfg.dry_run, outcome: "error", errorCode: listed.error, detail: c.message, changed: false };
    if (c.kind === "group") await setHealth(db, cfg.id, "error", c.message);
    await recordAction(db, cfg, memberRef, slackUserId, rec);
    return { ...base, memberState: member.state, slackUserId, action: rec };
  }
  const current = listed.data.users ?? [];
  const plan = planUsergroupMember(cfg, member.state, slackUserId, current);

  if (plan.action === "none") {
    await setHealth(db, cfg.id, "ok", null);
    return { ...base, memberState: member.state, slackUserId, action: null };
  }
  if (plan.action === "skip") {
    const rec: UsergroupActionRecord = { action: "skip", dryRun: cfg.dry_run, outcome: "skipped", errorCode: plan.code, detail: plan.reason, changed: false };
    await recordAction(db, cfg, memberRef, slackUserId, rec);
    return { ...base, memberState: member.state, slackUserId, action: rec };
  }

  const target = slackUserId as string;
  if (plan.action === "remove") {
    const removal = await checkRemovable(client, target);
    if (!removal.removable) {
      const rec: UsergroupActionRecord = { action: "skip", dryRun: cfg.dry_run, outcome: "skipped", errorCode: removal.code, detail: removal.reason, changed: false };
      await recordAction(db, cfg, memberRef, target, rec);
      return { ...base, memberState: member.state, slackUserId, action: rec };
    }
  }

  if (cfg.dry_run) {
    const rec: UsergroupActionRecord = {
      action: plan.action,
      dryRun: true,
      outcome: "would_do",
      errorCode: null,
      detail: `Dry run: would ${plan.action === "add" ? "add to" : "remove from"} the user group (${plan.reason})`,
      changed: false,
    };
    await recordAction(db, cfg, memberRef, target, rec);
    return { ...base, memberState: member.state, slackUserId, action: rec };
  }

  const updated = await client.usergroupsUsersUpdate(cfg.usergroup_id, plan.next);
  let rec: UsergroupActionRecord;
  if (updated.ok) {
    rec = { action: plan.action, dryRun: false, outcome: "done", errorCode: null, detail: plan.reason, changed: true };
    await setHealth(db, cfg.id, "ok", null);
  } else {
    const c = classify(updated.error ?? "unknown_error");
    rec = { action: plan.action, dryRun: false, outcome: "error", errorCode: updated.error, detail: c.message, changed: false };
    if (c.kind === "group") await setHealth(db, cfg.id, "error", c.message);
  }
  await recordAction(db, cfg, memberRef, target, rec);
  return { ...base, memberState: member.state, slackUserId, action: rec };
}
