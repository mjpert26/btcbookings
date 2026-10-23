import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { serviceTx, withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { enqueue } from "@/server/jobs/queue";
import { SLACK_CONFIG_ERRORS, slackClientFromEnv, SlackNotConfiguredError, type SlackClient } from "@/server/slack/client";
import { SlackAdminError } from "@/server/slack/admin";
import { configErrorMessage } from "@/server/slack/sync";
import { SLACK_USER_ID_RE, USERGROUP_ID_RE } from "@/server/slack/plan";

/**
 * Admin functions for a team's Slack user group (BTCSCHED-50). Global admins only; every
 * change runs through withUser (RLS applies) and writes its audit entry in the same
 * transaction. A new link always starts in dry-run mode, so linking never changes Slack.
 */

export type UsergroupConfigRow = {
  id: string;
  team_id: string;
  usergroup_id: string;
  usergroup_handle: string | null;
  mode: "add_only" | "add_and_remove";
  dry_run: boolean;
  protected_slack_user_ids: string[];
  health: "unknown" | "ok" | "bot_not_in_channel" | "error";
  last_error: string | null;
  last_checked_at: Date | null;
};

const COLUMNS = ["id", "team_id", "usergroup_id", "usergroup_handle", "mode", "dry_run", "protected_slack_user_ids", "health", "last_error", "last_checked_at"];

const usergroupId = z.string().trim().toUpperCase().regex(USERGROUP_ID_RE, "Slack user group ids look like S0123456789");
const handle = z
  .string()
  .trim()
  .max(80)
  .transform((v) => v.replace(/^@/, ""))
  .nullish()
  .transform((v) => (v ? v : null));
const slackUserIds = z.array(z.string().trim().toUpperCase().regex(SLACK_USER_ID_RE, "Slack user ids look like U0123456789")).max(500);
const mode = z.enum(["add_only", "add_and_remove"]);
const uuid = z.string().uuid();

const linkSchema = z
  .object({ usergroupId, handle, mode: mode.default("add_only"), protectedSlackUserIds: slackUserIds.default([]) })
  .strict();
const updateSchema = z.object({ handle: handle.optional(), mode: mode.optional(), protectedSlackUserIds: slackUserIds.optional() }).strict();

export type LinkUsergroupInput = z.input<typeof linkSchema>;
export type UpdateUsergroupInput = z.input<typeof updateSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new SlackAdminError("invalid_input", r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

async function requireAdmin(tx: Tx): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!row?.ok) throw new SlackAdminError("forbidden", "Only admins can manage Slack user group sync");
}

async function loadConfig(tx: Tx, id: string): Promise<UsergroupConfigRow> {
  const [row] = await tx<UsergroupConfigRow[]>`
    select ${tx(COLUMNS)} from app.team_slack_usergroups where id = ${parse(uuid, id)}
  `;
  if (!row) throw new SlackAdminError("not_found", "Slack user group link not found");
  return row;
}

const auditView = (r: UsergroupConfigRow) => ({
  team_id: r.team_id,
  usergroup_id: r.usergroup_id,
  usergroup_handle: r.usergroup_handle,
  mode: r.mode,
  dry_run: r.dry_run,
  protected_slack_user_ids: r.protected_slack_user_ids,
});

export type UsergroupHealth = { health: UsergroupConfigRow["health"]; lastError: string | null };

/** Reads the group's members once to confirm the app can see it. Never changes Slack. */
export async function checkUsergroupAccess(client: SlackClient | null, id: string): Promise<UsergroupHealth> {
  if (!client) return { health: "unknown", lastError: "Slack is not configured on this deployment (SLACK_BOT_TOKEN is not set)." };
  const res = await client.usergroupsUsersList(id);
  if (res.ok) return { health: "ok", lastError: null };
  const code = res.error ?? "unknown_error";
  if (SLACK_CONFIG_ERRORS.has(code)) return { health: "error", lastError: configErrorMessage(code) };
  if (code === "no_such_subteam") return { health: "error", lastError: "The Slack user group was not found. Check the user group id." };
  if (code === "plan_upgrade_required") return { health: "error", lastError: "This Slack workspace plan does not include user groups." };
  return { health: "unknown", lastError: `Slack returned ${code}` };
}

function clientOrNull(opts: { client?: SlackClient }): SlackClient | null {
  if (opts.client) return opts.client;
  try {
    return slackClientFromEnv();
  } catch (err) {
    if (err instanceof SlackNotConfiguredError) return null;
    throw err;
  }
}

/** Links a Slack user group to a team (one per team, one team per group). Starts in dry-run mode. */
export async function linkUsergroup(
  actorUserId: string,
  teamId: string,
  input: LinkUsergroupInput,
  opts: { client?: SlackClient } = {},
): Promise<UsergroupConfigRow> {
  const data = parse(linkSchema, input);
  const team = parse(uuid, teamId);
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const [t] = await tx`select id from app.teams where id = ${team}`;
    if (!t) throw new SlackAdminError("not_found", "Team not found");
    const [dup] = await tx`select id from app.team_slack_usergroups where team_id = ${team}`;
    if (dup) throw new SlackAdminError("duplicate", "This team already has a Slack user group linked");
    // One team per group (unique usergroup_id), so a removal on one team never takes a rep
    // out of a group they still belong to through another team.
    const [taken] = await tx`select id from app.team_slack_usergroups where usergroup_id = ${data.usergroupId}`;
    if (taken) throw new SlackAdminError("duplicate", "This Slack user group is already linked to another team");
    const h = await checkUsergroupAccess(clientOrNull(opts), data.usergroupId);
    const [row] = await tx<UsergroupConfigRow[]>`
      insert into app.team_slack_usergroups
        (team_id, usergroup_id, usergroup_handle, mode, dry_run, protected_slack_user_ids, health, last_error, last_checked_at)
      values (${team}, ${data.usergroupId}, ${data.handle}, ${data.mode}, true, ${data.protectedSlackUserIds},
              ${h.health}, ${h.lastError}, now())
      returning ${tx(COLUMNS)}
    `;
    await writeAudit(tx, { actorUserId, action: "slack_usergroup.created", entityType: "team_slack_usergroup", entityId: row.id, after: auditView(row) });
    return row;
  });
}

/** Changes the handle, mode or protected users. Dry run has its own function. */
export async function updateUsergroup(actorUserId: string, configId: string, input: UpdateUsergroupInput): Promise<UsergroupConfigRow> {
  const data = parse(updateSchema, input);
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, configId);
    const [row] = await tx<UsergroupConfigRow[]>`
      update app.team_slack_usergroups set
        usergroup_handle = ${data.handle === undefined ? before.usergroup_handle : data.handle},
        mode = ${data.mode ?? before.mode},
        protected_slack_user_ids = ${data.protectedSlackUserIds ?? before.protected_slack_user_ids}
      where id = ${before.id}
      returning ${tx(COLUMNS)}
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_usergroup.updated",
      entityType: "team_slack_usergroup",
      entityId: row.id,
      before: auditView(before),
      after: auditView(row),
    });
    return row;
  });
}

/** Turns dry run on or off. Off makes the sync change the Slack user group for real. */
export async function setUsergroupDryRun(actorUserId: string, configId: string, dryRun: boolean): Promise<UsergroupConfigRow> {
  const flag = parse(z.boolean(), dryRun);
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, configId);
    const [row] = await tx<UsergroupConfigRow[]>`
      update app.team_slack_usergroups set dry_run = ${flag} where id = ${before.id} returning ${tx(COLUMNS)}
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_usergroup.dry_run_changed",
      entityType: "team_slack_usergroup",
      entityId: row.id,
      before: { dry_run: before.dry_run },
      after: { dry_run: row.dry_run },
    });
    return row;
  });
}

/** Unlinks the user group. Slack membership is left as it is; the action history is kept. */
export async function unlinkUsergroup(actorUserId: string, configId: string): Promise<void> {
  await withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, configId);
    await tx`delete from app.team_slack_usergroups where id = ${before.id}`;
    await writeAudit(tx, { actorUserId, action: "slack_usergroup.removed", entityType: "team_slack_usergroup", entityId: before.id, before: auditView(before) });
  });
}

/** Re-reads the group from Slack and updates its health. */
export async function checkUsergroupHealth(actorUserId: string, configId: string, opts: { client?: SlackClient } = {}): Promise<UsergroupConfigRow> {
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, configId);
    const h = await checkUsergroupAccess(clientOrNull(opts), before.usergroup_id);
    const [row] = await tx<UsergroupConfigRow[]>`
      update app.team_slack_usergroups set health = ${h.health}, last_error = ${h.lastError}, last_checked_at = now()
      where id = ${before.id} returning ${tx(COLUMNS)}
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_usergroup.health_checked",
      entityType: "team_slack_usergroup",
      entityId: row.id,
      before: { health: before.health, last_error: before.last_error },
      after: { health: row.health, last_error: row.last_error },
    });
    return row;
  });
}

/**
 * Enqueues slack_usergroup_sync for every member of the team. Runs in a service transaction
 * because app_user has no insert grant on app.jobs; the actor's admin status is checked with
 * the actor's claims set, and the audit entry commits with the jobs.
 */
export async function resyncUsergroup(actorUserId: string, configId: string): Promise<{ enqueued: number }> {
  const id = parse(uuid, configId);
  const actor = parse(uuid, actorUserId);
  return serviceTx(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor })}, true)`;
    await requireAdmin(tx);
    const cfg = await loadConfig(tx, id);
    const members = await tx<{ id: string }[]>`select id from app.team_members where team_id = ${cfg.team_id} order by id`;
    const resyncId = randomUUID();
    let enqueued = 0;
    for (const m of members) {
      const jobId = await enqueue(tx, {
        kind: "slack_usergroup_sync",
        payload: { teamId: cfg.team_id, teamMemberId: m.id },
        idempotencyKey: `slack-usergroup-resync:${resyncId}:${m.id}`,
        teamId: cfg.team_id,
      });
      if (jobId) enqueued++;
    }
    await writeAudit(tx, {
      actorUserId: actor,
      action: "slack_usergroup.full_resync",
      entityType: "team_slack_usergroup",
      entityId: cfg.id,
      after: { enqueued, resync_id: resyncId },
    });
    return { enqueued };
  });
}
