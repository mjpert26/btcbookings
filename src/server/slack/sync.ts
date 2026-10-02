import "server-only";
import type { Db, Sql } from "@/server/db/client";
import { env } from "@/server/env";
import { RetryAfterError } from "@/server/jobs/types";
import { SLACK_CONFIG_ERRORS, type SlackClient, type SlackResponse } from "@/server/slack/client";
import {
  BOT_NOT_IN_CHANNEL_MESSAGE,
  REMOVALS_BLOCKED_MESSAGE,
  intendedAction,
  noticeReason,
  noticeText,
  planMemberAction,
  type ChannelConfig,
  type MemberState,
  type PlannedAction,
} from "@/server/slack/plan";

/**
 * Applies a team member's current status to every Slack channel linked to the team.
 *
 * Flow of truth: Salesforce Queue -> team member status -> Slack channels. This module
 * reads team state and writes Slack; it never changes team membership.
 */

/** Identity cache entries older than this are refreshed with users.lookupByEmail. */
export const IDENTITY_TTL_DAYS = 30;

/** Slack errors worth retrying with backoff (transient upstream failures). */
const TRANSIENT_ERRORS = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout", "invalid_response"]);
const isTransient = (code: string | null) => !!code && (TRANSIENT_ERRORS.has(code) || code.startsWith("http_5"));

/** The bot token is missing a scope or is invalid. Not retryable until an admin fixes it. */
export class SlackConfigError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? `Slack configuration error: ${code}`);
    this.name = "SlackConfigError";
  }
}

/** A transient Slack failure in at least one channel. The job retries with backoff. */
export class SlackTransientError extends Error {
  constructor(readonly codes: string[]) {
    super(`Transient Slack error: ${codes.join(", ")}`);
    this.name = "SlackTransientError";
  }
}

export type MemberRecord = {
  teamMemberId: string;
  teamId: string;
  teamName: string;
  userId: string | null;
  email: string | null;
  state: MemberState;
};

export type ChannelRow = ChannelConfig & { health: string };

export type ActionRecord = {
  channelConfigId: string;
  channelId: string;
  action: "invite" | "kick" | "skip";
  dryRun: boolean;
  outcome: "done" | "would_do" | "skipped" | "error";
  errorCode: string | null;
  detail: string | null;
  /** True when Slack membership actually changed (not an idempotent no-op). */
  changed: boolean;
  noticePosted?: boolean;
  noticeError?: string | null;
};

export type SyncResult = {
  memberState: MemberState | "not_found";
  slackUserId: string | null;
  actions: ActionRecord[];
};

export type SyncOptions = {
  /** Overrides SLACK_ADMIN_NOTIFY_CHANNEL (fallback when a channel has no notify_channel_id). */
  adminNotifyChannel?: string | null;
  /** Clock for the identity cache. */
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

export async function loadChannels(db: Db, teamId: string): Promise<ChannelRow[]> {
  return db<ChannelRow[]>`
    select id, team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids,
           notify_channel_id, health
    from app.team_slack_channels where team_id = ${teamId}
    order by created_at, id
  `;
}

/**
 * Loads the member's current status. A member row that no longer exists is treated as
 * removed; its email is recovered from the latest membership event when possible.
 */
export async function loadMember(db: Db, teamId: string, teamMemberId: string): Promise<MemberRecord | null> {
  const [team] = await db<{ name: string }[]>`select name from app.teams where id = ${teamId}`;
  if (!team) return null;
  const [m] = await db<{ user_id: string | null; email: string; status: MemberState }[]>`
    select user_id, email, status from app.team_members where id = ${teamMemberId} and team_id = ${teamId}
  `;
  if (m) {
    return { teamMemberId, teamId, teamName: team.name, userId: m.user_id, email: m.email, state: m.status };
  }
  const [ev] = await db<{ email: string }[]>`
    select email from app.membership_events
    where team_id = ${teamId}
      and (team_member_id = ${teamMemberId} or detail ->> 'team_member_id' = ${teamMemberId})
    order by created_at desc limit 1
  `;
  let userId: string | null = null;
  if (ev) {
    const [u] = await db<{ id: string }[]>`select id from app.users where email = ${ev.email}`;
    userId = u?.id ?? null;
  }
  return { teamMemberId, teamId, teamName: team.name, userId, email: ev?.email ?? null, state: "removed" };
}

async function latestEventSource(db: Db, teamId: string, teamMemberId: string): Promise<string | null> {
  const [ev] = await db<{ source: string }[]>`
    select source from app.membership_events
    where team_id = ${teamId} and team_member_id = ${teamMemberId}
    order by created_at desc limit 1
  `;
  return ev?.source ?? null;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export type IdentityResult = { slackUserId: string | null; source: "cache" | "lookup" | "none"; errorCode?: string };

/**
 * Resolves a Slack user id by email. Uses app.slack_identities (keyed by app user) when the
 * entry is younger than IDENTITY_TTL_DAYS. `users_not_found` returns null rather than
 * throwing so that a missing Slack account never causes a retry loop.
 */
export async function resolveSlackUserId(
  db: Db,
  client: SlackClient,
  member: { userId: string | null; email: string | null },
  opts: { now?: Date; writeCache?: boolean } = {},
): Promise<IdentityResult> {
  const now = opts.now ?? new Date();
  if (member.userId) {
    const cutoff = new Date(now.getTime() - IDENTITY_TTL_DAYS * 86_400_000);
    const [cached] = await db<{ slack_user_id: string }[]>`
      select slack_user_id from app.slack_identities
      where user_id = ${member.userId} and resolved_at > ${cutoff}
    `;
    if (cached) return { slackUserId: cached.slack_user_id, source: "cache" };
  }
  if (!member.email) return { slackUserId: null, source: "none", errorCode: "no_email" };

  const res = await client.usersLookupByEmail(member.email);
  if (!res.ok) {
    if (res.error === "users_not_found" || res.error === "user_not_found") {
      return { slackUserId: null, source: "lookup", errorCode: res.error };
    }
    if (res.error && SLACK_CONFIG_ERRORS.has(res.error)) throw new SlackConfigError(res.error);
    throw new SlackTransientError([res.error ?? "unknown_error"]);
  }
  const user = res.data?.user;
  if (!user?.id || user.deleted) return { slackUserId: null, source: "lookup", errorCode: "users_not_found" };
  if (member.userId && opts.writeCache !== false) {
    await db`
      insert into app.slack_identities (user_id, slack_user_id, resolved_at)
      values (${member.userId}, ${user.id}, ${now})
      on conflict (user_id) do update set slack_user_id = excluded.slack_user_id, resolved_at = excluded.resolved_at
    `;
  }
  return { slackUserId: user.id, source: "lookup" };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type ChannelPlan = { channel: ChannelRow; plan: PlannedAction };

/**
 * Computes the action for one member in every channel of the team. Looks up the Slack
 * user id only when some channel needs an invite or kick.
 */
export async function computeChannelActions(
  db: Db,
  client: SlackClient,
  teamId: string,
  teamMemberId: string,
  opts: SyncOptions = {},
): Promise<{ member: MemberRecord | null; slackUserId: string | null; plans: ChannelPlan[] }> {
  const member = await loadMember(db, teamId, teamMemberId);
  if (!member) return { member: null, slackUserId: null, plans: [] };
  const channels = await loadChannels(db, teamId);
  const needsIdentity = channels.some((c) => intendedAction(c.mode, member.state) !== "none");
  let slackUserId: string | null = null;
  if (needsIdentity) {
    const identity = await resolveSlackUserId(db, client, member, { now: opts.now?.() });
    slackUserId = identity.slackUserId;
  }
  const plans = channels.map((channel) => ({ channel, plan: planMemberAction(channel, member.state, slackUserId) }));
  return { member, slackUserId, plans };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function recordAction(db: Db, teamId: string, teamMemberId: string | null, slackUserId: string | null, a: ActionRecord) {
  await db`
    insert into app.slack_channel_actions
      (team_id, channel_config_id, team_member_id, channel_id, slack_user_id, action, dry_run, outcome, error_code, detail)
    values (${teamId}, ${a.channelConfigId}, ${teamMemberId}, ${a.channelId}, ${slackUserId}, ${a.action},
            ${a.dryRun}, ${a.outcome}, ${a.errorCode}, ${a.detail})
  `;
}

export async function setChannelHealth(
  db: Db,
  channelConfigId: string,
  health: "ok" | "bot_not_in_channel" | "error" | "unknown",
  lastError: string | null,
): Promise<void> {
  await db`
    update app.team_slack_channels
    set health = ${health}, last_error = ${lastError}, last_checked_at = now()
    where id = ${channelConfigId}
  `;
}

export async function setTeamChannelsHealth(db: Db, teamId: string, health: "error", lastError: string): Promise<void> {
  await db`
    update app.team_slack_channels set health = ${health}, last_error = ${lastError}, last_checked_at = now()
    where team_id = ${teamId}
  `;
}

export function configErrorMessage(code: string): string {
  switch (code) {
    case "missing_scope":
      return "The Slack bot token is missing a required scope (missing_scope). Reinstall the app from slack/manifest.yml.";
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return `The Slack bot token is invalid or revoked (${code}). Update SLACK_BOT_TOKEN and redeploy.`;
    default:
      return `Slack rejected the app's credentials (${code}).`;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Step =
  | { kind: "done"; changed: boolean }
  | { kind: "skipped"; code: string; detail: string }
  | { kind: "channel_health"; health: "bot_not_in_channel" | "error"; code: string; detail: string }
  | { kind: "member_error"; code: string; detail: string }
  | { kind: "transient"; code: string };

function mapCommonError(code: string): Step {
  if (SLACK_CONFIG_ERRORS.has(code)) throw new SlackConfigError(code);
  if (isTransient(code)) return { kind: "transient", code };
  switch (code) {
    case "channel_not_found":
      return { kind: "channel_health", health: "bot_not_in_channel", code, detail: BOT_NOT_IN_CHANNEL_MESSAGE };
    case "is_archived":
      return { kind: "channel_health", health: "error", code, detail: "The Slack channel is archived." };
    case "method_not_supported_for_channel_type":
      return { kind: "channel_health", health: "error", code, detail: "This conversation type cannot be managed by the app." };
    default:
      return { kind: "member_error", code, detail: `Slack returned ${code}` };
  }
}

/**
 * Handles `not_in_channel`: inspects the channel, joins it when it is public and the bot is
 * not a member, and retries the call once. For a private channel the bot must be invited.
 */
async function recoverBotMembership(
  client: SlackClient,
  channelId: string,
  retry: () => Promise<SlackResponse<unknown>>,
  interpret: (res: SlackResponse<unknown>) => Step,
  botIsMemberMeans: Step | null,
): Promise<Step> {
  const info = await client.conversationsInfo(channelId);
  if (!info.ok || !info.data) {
    if (info.error === "channel_not_found") {
      return { kind: "channel_health", health: "bot_not_in_channel", code: "not_in_channel", detail: BOT_NOT_IN_CHANNEL_MESSAGE };
    }
    return mapCommonError(info.error ?? "unknown_error");
  }
  const ch = info.data.channel;
  if (ch.is_member) {
    // The bot is in the channel, so not_in_channel referred to the target user.
    return botIsMemberMeans ?? { kind: "member_error", code: "not_in_channel", detail: "Slack returned not_in_channel" };
  }
  if (ch.is_private) {
    return { kind: "channel_health", health: "bot_not_in_channel", code: "not_in_channel", detail: BOT_NOT_IN_CHANNEL_MESSAGE };
  }
  const joined = await client.conversationsJoin(channelId);
  if (!joined.ok) {
    if (joined.error === "missing_scope") throw new SlackConfigError("missing_scope");
    if (joined.error === "method_not_supported_for_channel_type" || joined.error === "channel_not_found") {
      return { kind: "channel_health", health: "bot_not_in_channel", code: joined.error, detail: BOT_NOT_IN_CHANNEL_MESSAGE };
    }
    return mapCommonError(joined.error ?? "unknown_error");
  }
  const second = await retry();
  const step = interpret(second);
  if (step.kind === "channel_health" && step.code === "not_in_channel") {
    return { kind: "channel_health", health: "bot_not_in_channel", code: "not_in_channel", detail: BOT_NOT_IN_CHANNEL_MESSAGE };
  }
  return step;
}

async function runInvite(client: SlackClient, channelId: string, slackUserId: string): Promise<Step> {
  const interpret = (res: SlackResponse<unknown>): Step => {
    if (res.ok) return { kind: "done", changed: true };
    if (res.error === "already_in_channel") return { kind: "done", changed: false };
    if (res.error === "not_in_channel") {
      return { kind: "channel_health", health: "bot_not_in_channel", code: "not_in_channel", detail: BOT_NOT_IN_CHANNEL_MESSAGE };
    }
    return mapCommonError(res.error ?? "unknown_error");
  };
  const first = await client.conversationsInvite(channelId, slackUserId);
  if (!first.ok && first.error === "not_in_channel") {
    return recoverBotMembership(client, channelId, () => client.conversationsInvite(channelId, slackUserId), interpret, null);
  }
  return interpret(first);
}

async function runKick(client: SlackClient, channelId: string, slackUserId: string): Promise<Step> {
  const interpret = (res: SlackResponse<unknown>): Step => {
    if (res.ok) return { kind: "done", changed: true };
    switch (res.error) {
      case "not_in_channel":
        // After the bot has joined, not_in_channel can only refer to the target user.
        return { kind: "done", changed: false };
      case "cant_kick_self":
        return { kind: "skipped", code: "cant_kick_self", detail: "The bot cannot remove itself" };
      case "cant_kick_from_general":
        return { kind: "skipped", code: "cant_kick_from_general", detail: "Members cannot be removed from #general" };
      case "restricted_action":
        return { kind: "channel_health", health: "error", code: "restricted_action", detail: REMOVALS_BLOCKED_MESSAGE };
      default:
        return mapCommonError(res.error ?? "unknown_error");
    }
  };
  const first = await client.conversationsKick(channelId, slackUserId);
  if (!first.ok && first.error === "not_in_channel") {
    return recoverBotMembership(
      client,
      channelId,
      () => client.conversationsKick(channelId, slackUserId),
      interpret,
      { kind: "done", changed: false },
    );
  }
  return interpret(first);
}

function adminNotifyFallback(opts: SyncOptions): string | null {
  if (opts.adminNotifyChannel !== undefined) return opts.adminNotifyChannel;
  try {
    return env().SLACK_ADMIN_NOTIFY_CHANNEL ?? null;
  } catch {
    return null;
  }
}

/** Posts the admin notice. Never throws: a failed notice must not fail the sync. */
async function postNotice(client: SlackClient, channel: string, text: string): Promise<{ posted: boolean; error: string | null }> {
  try {
    const res = await client.chatPostMessage(channel, text);
    return { posted: res.ok, error: res.ok ? null : res.error };
  } catch (err) {
    return { posted: false, error: err instanceof RetryAfterError ? "ratelimited" : "request_failed" };
  }
}

/**
 * Applies the member's current status to every channel of the team. Idempotent: running
 * it twice leaves Slack in the same state and only appends to the action log.
 *
 * Throws RetryAfterError on rate limits, SlackConfigError on credential or scope problems
 * (after marking every channel of the team as unhealthy), and SlackTransientError when a
 * channel failed transiently (after processing the remaining channels).
 */
export async function syncMemberChannels(
  sql: Sql,
  client: SlackClient,
  input: { teamId: string; teamMemberId: string },
  opts: SyncOptions = {},
): Promise<SyncResult> {
  // Serialize work per member so a quick active -> paused -> active sequence cannot
  // interleave. The lock transaction only holds the lock; writes use the pool so that
  // log rows and health updates persist even when the job is retried.
  return (await sql.begin(async (lockTx) => {
    await lockTx`select pg_advisory_xact_lock(hashtext(${"slack-member:" + input.teamMemberId}))`;
    return syncMemberChannelsUnlocked(sql, client, input, opts);
  })) as SyncResult;
}

async function syncMemberChannelsUnlocked(
  db: Sql,
  client: SlackClient,
  input: { teamId: string; teamMemberId: string },
  opts: SyncOptions,
): Promise<SyncResult> {
  let computed: Awaited<ReturnType<typeof computeChannelActions>>;
  try {
    computed = await computeChannelActions(db, client, input.teamId, input.teamMemberId, opts);
  } catch (err) {
    if (err instanceof SlackConfigError) await setTeamChannelsHealth(db, input.teamId, "error", configErrorMessage(err.code));
    throw err;
  }
  const { member, slackUserId, plans } = computed;
  if (!member) return { memberState: "not_found", slackUserId: null, actions: [] };

  const memberRef = member.state === "removed" ? null : member.teamMemberId;
  const actions: ActionRecord[] = [];
  const transient: string[] = [];
  let reason: string | null = null;

  for (const { channel, plan } of plans) {
    if (plan.action === "none") continue;

    const base = { channelConfigId: channel.id, channelId: channel.channel_id, dryRun: channel.dry_run };
    if (plan.action === "skip") {
      const rec: ActionRecord = { ...base, action: "skip", outcome: "skipped", errorCode: plan.code, detail: plan.reason, changed: false };
      await recordAction(db, member.teamId, memberRef, slackUserId, rec);
      actions.push(rec);
      continue;
    }

    const target = slackUserId as string;
    if (channel.dry_run) {
      const rec: ActionRecord = {
        ...base,
        action: plan.action,
        outcome: "would_do",
        errorCode: null,
        detail: `Dry run: would ${plan.action === "invite" ? "invite" : "remove"} (${plan.reason})`,
        changed: false,
      };
      await recordAction(db, member.teamId, memberRef, target, rec);
      actions.push(rec);
      continue;
    }

    let step: Step;
    try {
      step = plan.action === "invite" ? await runInvite(client, channel.channel_id, target) : await runKick(client, channel.channel_id, target);
    } catch (err) {
      if (err instanceof SlackConfigError) {
        const msg = configErrorMessage(err.code);
        await setTeamChannelsHealth(db, member.teamId, "error", msg);
        await recordAction(db, member.teamId, memberRef, target, {
          ...base, action: plan.action, outcome: "error", errorCode: err.code, detail: msg, changed: false,
        });
      }
      throw err;
    }

    let rec: ActionRecord;
    switch (step.kind) {
      case "done":
        rec = { ...base, action: plan.action, outcome: "done", errorCode: null, detail: step.changed ? plan.reason : "Already in the desired state", changed: step.changed };
        if (plan.action === "invite") {
          // A successful invite does not prove removals work, so keep a removals-blocked error.
          await db`
            update app.team_slack_channels set health = 'ok', last_error = null, last_checked_at = now()
            where id = ${channel.id} and coalesce(last_error, '') not like '%(restricted_action)%'
          `;
        } else {
          await setChannelHealth(db, channel.id, "ok", null);
        }
        break;
      case "skipped":
        rec = { ...base, action: "skip", outcome: "skipped", errorCode: step.code, detail: step.detail, changed: false };
        break;
      case "channel_health":
        rec = { ...base, action: plan.action, outcome: "error", errorCode: step.code, detail: step.detail, changed: false };
        await setChannelHealth(db, channel.id, step.health, step.detail);
        break;
      case "member_error":
        rec = { ...base, action: plan.action, outcome: "error", errorCode: step.code, detail: step.detail, changed: false };
        break;
      case "transient":
        rec = { ...base, action: plan.action, outcome: "error", errorCode: step.code, detail: "Transient Slack error; will retry", changed: false };
        transient.push(step.code);
        break;
    }

    if (rec.changed && (plan.action === "invite" || plan.action === "kick")) {
      const notifyTo = channel.notify_channel_id ?? adminNotifyFallback(opts);
      if (notifyTo) {
        reason ??= noticeReason(await latestEventSource(db, member.teamId, member.teamMemberId));
        const notice = await postNotice(client, notifyTo, noticeText(plan.action, target, channel.channel_id, member.teamName, reason));
        rec.noticePosted = notice.posted;
        rec.noticeError = notice.error;
      }
    }

    await recordAction(db, member.teamId, memberRef, target, rec);
    actions.push(rec);
  }

  if (transient.length > 0) throw new SlackTransientError(transient);
  return { memberState: member.state, slackUserId, actions };
}
