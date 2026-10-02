import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { serviceTx, withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { enqueue } from "@/server/jobs/queue";
import {
  listAllChannelMembers,
  SLACK_CONFIG_ERRORS,
  slackClientFromEnv,
  type SlackClient,
  type SlackResponse,
  type SlackChannelInfo,
} from "@/server/slack/client";
import { configErrorMessage, resolveSlackUserId } from "@/server/slack/sync";
import {
  BOT_NOT_IN_CHANNEL_MESSAGE,
  CHANNEL_ID_RE,
  SLACK_USER_ID_RE,
  computePreview,
  type ChannelPreview,
  type MemberStatus,
  type PreviewMember,
} from "@/server/slack/plan";

/**
 * Admin server functions for Slack channel configs. No UI here; the admin UI calls these.
 * Every function requires a global admin, runs through withUser so RLS applies, and writes
 * the audit entry in the same transaction as the change.
 */

export class SlackAdminError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "invalid_input" | "duplicate" | "slack_error", message: string) {
    super(message);
    this.name = "SlackAdminError";
  }
}

export type AdminOptions = { client?: SlackClient };

export type ChannelConfigRow = {
  id: string;
  team_id: string;
  channel_id: string;
  channel_name: string | null;
  mode: "add_only" | "add_and_remove";
  dry_run: boolean;
  protected_slack_user_ids: string[];
  notify_channel_id: string | null;
  health: "unknown" | "ok" | "bot_not_in_channel" | "error";
  last_error: string | null;
  last_checked_at: Date | null;
};

const channelId = z.string().trim().regex(CHANNEL_ID_RE, "Slack channel ids look like C0123456789");
const slackUserId = z.string().trim().regex(SLACK_USER_ID_RE, "Slack user ids look like U0123456789");
const mode = z.enum(["add_only", "add_and_remove"]);

const addSchema = z.object({
  channelId,
  mode: mode.default("add_only"),
  protectedSlackUserIds: z.array(slackUserId).max(500).default([]),
  notifyChannelId: channelId.nullish(),
});
const updateSchema = z
  .object({
    mode: mode.optional(),
    protectedSlackUserIds: z.array(slackUserId).max(500).optional(),
    notifyChannelId: channelId.nullable().optional(),
  })
  .strict();
const uuid = z.string().uuid();

export type AddChannelInput = z.input<typeof addSchema>;
export type UpdateChannelInput = z.input<typeof updateSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new SlackAdminError("invalid_input", r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

async function requireAdmin(tx: Tx): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!row?.ok) throw new SlackAdminError("forbidden", "Only admins can manage Slack channel sync");
}

async function loadConfig(tx: Tx, id: string): Promise<ChannelConfigRow> {
  const [row] = await tx<ChannelConfigRow[]>`
    select id, team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id,
           health, last_error, last_checked_at
    from app.team_slack_channels where id = ${parse(uuid, id)}
  `;
  if (!row) throw new SlackAdminError("not_found", "Slack channel config not found");
  return row;
}

const client = (opts: AdminOptions) => opts.client ?? slackClientFromEnv();

type Health = { health: ChannelConfigRow["health"]; lastError: string | null; name: string | null };

/** Maps a conversations.info result to a channel health value. */
export function healthFromInfo(res: SlackResponse<{ channel: SlackChannelInfo }>): Health {
  if (res.ok && res.data?.channel) {
    const ch = res.data.channel;
    if (ch.is_archived) return { health: "error", lastError: "The Slack channel is archived.", name: ch.name };
    if (!ch.is_member && ch.is_private) return { health: "bot_not_in_channel", lastError: BOT_NOT_IN_CHANNEL_MESSAGE, name: ch.name };
    // A public channel the bot has not joined is fine: the sync joins it on first use.
    return { health: "ok", lastError: null, name: ch.name };
  }
  const code = res.error ?? "unknown_error";
  if (code === "channel_not_found") return { health: "bot_not_in_channel", lastError: BOT_NOT_IN_CHANNEL_MESSAGE, name: null };
  if (SLACK_CONFIG_ERRORS.has(code)) return { health: "error", lastError: configErrorMessage(code), name: null };
  return { health: "unknown", lastError: `Slack returned ${code}`, name: null };
}

const auditView = (r: ChannelConfigRow) => ({
  team_id: r.team_id,
  channel_id: r.channel_id,
  channel_name: r.channel_name,
  mode: r.mode,
  dry_run: r.dry_run,
  protected_slack_user_ids: r.protected_slack_user_ids,
  notify_channel_id: r.notify_channel_id,
});

/** Links a Slack channel to a team. New configs always start in dry-run mode. */
export async function addChannel(
  actorUserId: string,
  teamId: string,
  input: AddChannelInput,
  opts: AdminOptions = {},
): Promise<ChannelConfigRow> {
  const data = parse(addSchema, input);
  const team = parse(uuid, teamId);
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const [t] = await tx`select id from app.teams where id = ${team}`;
    if (!t) throw new SlackAdminError("not_found", "Team not found");
    const [dup] = await tx`select id from app.team_slack_channels where team_id = ${team} and channel_id = ${data.channelId}`;
    if (dup) throw new SlackAdminError("duplicate", "This channel is already linked to the team");

    const h = healthFromInfo(await client(opts).conversationsInfo(data.channelId));
    const [row] = await tx<ChannelConfigRow[]>`
      insert into app.team_slack_channels
        (team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id,
         health, last_error, last_checked_at)
      values (${team}, ${data.channelId}, ${h.name}, ${data.mode}, true, ${data.protectedSlackUserIds},
              ${data.notifyChannelId ?? null}, ${h.health}, ${h.lastError}, now())
      returning id, team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id,
                health, last_error, last_checked_at
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_channel.created",
      entityType: "team_slack_channel",
      entityId: row.id,
      after: auditView(row),
    });
    return row;
  });
}

/** Changes mode, protected users or the notice channel. Dry run has its own function. */
export async function updateChannel(
  actorUserId: string,
  channelConfigId: string,
  input: UpdateChannelInput,
): Promise<ChannelConfigRow> {
  const data = parse(updateSchema, input);
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, channelConfigId);
    const [row] = await tx<ChannelConfigRow[]>`
      update app.team_slack_channels set
        mode = ${data.mode ?? before.mode},
        protected_slack_user_ids = ${data.protectedSlackUserIds ?? before.protected_slack_user_ids},
        notify_channel_id = ${data.notifyChannelId === undefined ? before.notify_channel_id : data.notifyChannelId}
      where id = ${before.id}
      returning id, team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id,
                health, last_error, last_checked_at
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_channel.updated",
      entityType: "team_slack_channel",
      entityId: row.id,
      before: auditView(before),
      after: auditView(row),
    });
    return row;
  });
}

/** Turns dry-run mode on or off. Turning it off makes the sync change Slack for real. */
export async function setDryRun(actorUserId: string, channelConfigId: string, dryRun: boolean): Promise<ChannelConfigRow> {
  const flag = parse(z.boolean(), dryRun);
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, channelConfigId);
    const [row] = await tx<ChannelConfigRow[]>`
      update app.team_slack_channels set dry_run = ${flag} where id = ${before.id}
      returning id, team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id,
                health, last_error, last_checked_at
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_channel.dry_run_changed",
      entityType: "team_slack_channel",
      entityId: row.id,
      before: { dry_run: before.dry_run },
      after: { dry_run: row.dry_run },
    });
    return row;
  });
}

/** Unlinks a channel. Slack membership is left as it is; the action history is kept. */
export async function removeChannel(actorUserId: string, channelConfigId: string): Promise<void> {
  await withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, channelConfigId);
    await tx`delete from app.team_slack_channels where id = ${before.id}`;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_channel.removed",
      entityType: "team_slack_channel",
      entityId: before.id,
      before: auditView(before),
    });
  });
}

/** Re-reads the channel from Slack and updates health and the stored channel name. */
export async function checkChannelHealth(
  actorUserId: string,
  channelConfigId: string,
  opts: AdminOptions = {},
): Promise<ChannelConfigRow> {
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const before = await loadConfig(tx, channelConfigId);
    const h = healthFromInfo(await client(opts).conversationsInfo(before.channel_id));
    const [row] = await tx<ChannelConfigRow[]>`
      update app.team_slack_channels
      set health = ${h.health}, last_error = ${h.lastError}, last_checked_at = now(),
          channel_name = coalesce(${h.name}, channel_name)
      where id = ${before.id}
      returning id, team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id,
                health, last_error, last_checked_at
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "slack_channel.health_checked",
      entityType: "team_slack_channel",
      entityId: row.id,
      before: { health: before.health, last_error: before.last_error },
      after: { health: row.health, last_error: row.last_error },
    });
    return row;
  });
}

export type PreviewResult = ChannelPreview & { channelConfigId: string; channelId: string; channelMemberCount: number };

/**
 * Shows what a full sync would change, without changing anything: team members versus the
 * current channel members (conversations.members, all pages). Slack ids missing from the
 * cache are looked up by email but not written to the cache.
 */
export async function previewChannel(
  actorUserId: string,
  channelConfigId: string,
  opts: AdminOptions = {},
): Promise<PreviewResult> {
  return withUser(actorUserId, async (tx) => {
    await requireAdmin(tx);
    const cfg = await loadConfig(tx, channelConfigId);
    const slack = client(opts);

    const membersRes = await listAllChannelMembers(slack, cfg.channel_id);
    if (!membersRes.ok || !membersRes.data) {
      const code = membersRes.error ?? "unknown_error";
      const msg = code === "channel_not_found" ? BOT_NOT_IN_CHANNEL_MESSAGE : SLACK_CONFIG_ERRORS.has(code) ? configErrorMessage(code) : `Slack returned ${code}`;
      throw new SlackAdminError("slack_error", msg);
    }

    const rows = await tx<{ id: string; user_id: string | null; email: string; status: MemberStatus }[]>`
      select id, user_id, email, status from app.team_members where team_id = ${cfg.team_id} order by email
    `;
    const members: PreviewMember[] = [];
    for (const r of rows) {
      let id: string | null = null;
      if (r.status !== "pending_onboarding" && !(cfg.mode === "add_only" && r.status === "paused")) {
        const res = await resolveSlackUserId(tx, slack, { userId: r.user_id, email: r.email }, { writeCache: false });
        id = res.slackUserId;
      }
      members.push({ teamMemberId: r.id, email: r.email, status: r.status, slackUserId: id });
    }
    const preview = computePreview(cfg, members, membersRes.data.members);
    return { ...preview, channelConfigId: cfg.id, channelId: cfg.channel_id, channelMemberCount: membersRes.data.members.length };
  });
}

/**
 * Enqueues slack_membership_sync for every member of the channel's team. Each job applies
 * the member's status to all of the team's channels.
 *
 * Runs in a service transaction because app_user has no insert grant on app.jobs. The
 * actor's admin status is checked inside the same transaction with the actor's claims set,
 * and the audit entry commits with the jobs.
 */
export async function fullResync(actorUserId: string, channelConfigId: string): Promise<{ enqueued: number }> {
  const id = parse(uuid, channelConfigId);
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
        kind: "slack_membership_sync",
        payload: { teamId: cfg.team_id, teamMemberId: m.id },
        idempotencyKey: `slack-resync:${resyncId}:${m.id}`,
        teamId: cfg.team_id,
      });
      if (jobId) enqueued++;
    }
    await writeAudit(tx, {
      actorUserId: actor,
      action: "slack_channel.full_resync",
      entityType: "team_slack_channel",
      entityId: cfg.id,
      after: { enqueued, resync_id: resyncId },
    });
    return { enqueued };
  });
}
