import "server-only";
import { z } from "zod";
import { service } from "@/server/db/client";
import { PermanentJobError, type JobHandler, type JobResult } from "@/server/jobs/types";
import { slackClientFromEnv, SlackNotConfiguredError, type SlackClient } from "@/server/slack/client";
import { loadChannels, SlackConfigError, configErrorMessage, syncMemberChannels, type SyncOptions } from "@/server/slack/sync";
import { loadUsergroup, syncMemberUsergroup } from "@/server/slack/usergroup";

const payloadSchema = z.object({ teamId: z.string().uuid(), teamMemberId: z.string().uuid() });

export type SlackHandlerDeps = {
  /** Returns the Slack client. Defaults to one built from SLACK_BOT_TOKEN. */
  client?: () => SlackClient;
  options?: SyncOptions;
};

/** Result recorded when SLACK_BOT_TOKEN is not set: the job succeeds and changes nothing. */
export const SLACK_NOT_CONFIGURED = "slack_not_configured";

/**
 * Builds the slack module's job handlers. Tests inject a client backed by a mocked fetch.
 *
 * slack_membership_sync { teamId, teamMemberId }: loads the member's current status (not the
 * status at enqueue time) and applies it to every channel linked to the team.
 *
 * slack_usergroup_sync { teamId, teamMemberId }: the same for the team's Slack user group.
 *
 * Both are no-ops for teams without the matching Slack link, and both succeed with a
 * `skipped: slack_not_configured` result (and a log line) when SLACK_BOT_TOKEN is not set,
 * so an unconfigured deployment never builds up failing jobs.
 */
export function createSlackHandlers(deps: SlackHandlerDeps = {}): Record<string, JobHandler> {
  const getClient = deps.client ?? (() => slackClientFromEnv());

  /** Returns the client, or null after logging when Slack is not configured. */
  const clientOrSkip = (kind: string, teamId: string, teamMemberId: string): SlackClient | null => {
    try {
      return getClient();
    } catch (err) {
      if (err instanceof SlackNotConfiguredError) {
        console.info(JSON.stringify({ msg: "slack job skipped", kind, teamId, teamMemberId, reason: SLACK_NOT_CONFIGURED }));
        return null;
      }
      throw err;
    }
  };

  const configError = (err: unknown): never => {
    if (err instanceof SlackConfigError) throw new PermanentJobError(configErrorMessage(err.code), { errorCode: err.code });
    throw err;
  };

  const membershipSync: JobHandler = async (job, ctx): Promise<JobResult> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("Invalid slack_membership_sync payload");
    const { teamId, teamMemberId } = parsed.data;
    const sql = service();

    const channels = await loadChannels(sql, teamId);
    if (channels.length === 0) return { result: { channels: 0, actions: [] } };

    const client = clientOrSkip("slack_membership_sync", teamId, teamMemberId);
    if (!client) return { result: { skipped: SLACK_NOT_CONFIGURED } };

    ctx.log({ request: { kind: "slack_membership_sync", teamId, teamMemberId, channelIds: channels.map((c) => c.channel_id) } });
    try {
      const out = await syncMemberChannels(sql, client, { teamId, teamMemberId }, deps.options);
      return {
        result: {
          memberState: out.memberState,
          slackUserId: out.slackUserId,
          actions: out.actions.map((a) => ({
            channelId: a.channelId,
            action: a.action,
            outcome: a.outcome,
            dryRun: a.dryRun,
            errorCode: a.errorCode,
            noticePosted: a.noticePosted ?? null,
            noticeError: a.noticeError ?? null,
          })),
        },
      };
    } catch (err) {
      return configError(err);
    }
  };

  const usergroupSync: JobHandler = async (job, ctx): Promise<JobResult> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("Invalid slack_usergroup_sync payload");
    const { teamId, teamMemberId } = parsed.data;
    const sql = service();

    const cfg = await loadUsergroup(sql, teamId);
    if (!cfg) return { result: { usergroup: null } };

    const client = clientOrSkip("slack_usergroup_sync", teamId, teamMemberId);
    if (!client) return { result: { skipped: SLACK_NOT_CONFIGURED } };

    ctx.log({ request: { kind: "slack_usergroup_sync", teamId, teamMemberId, usergroupId: cfg.usergroup_id } });
    try {
      const out = await syncMemberUsergroup(sql, client, { teamId, teamMemberId }, deps.options);
      return {
        result: {
          memberState: out.memberState,
          slackUserId: out.slackUserId,
          usergroupId: out.usergroupId,
          action: out.action
            ? { action: out.action.action, outcome: out.action.outcome, dryRun: out.action.dryRun, errorCode: out.action.errorCode }
            : null,
        },
      };
    } catch (err) {
      return configError(err);
    }
  };

  return { slack_membership_sync: membershipSync, slack_usergroup_sync: usergroupSync };
}

/** Job handlers owned by the slack module. Keys are job kinds. */
export const slackHandlers: Record<string, JobHandler> = createSlackHandlers();
