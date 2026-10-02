import "server-only";
import { z } from "zod";
import { service } from "@/server/db/client";
import { PermanentJobError, type JobHandler } from "@/server/jobs/types";
import { slackClientFromEnv, SlackNotConfiguredError, type SlackClient } from "@/server/slack/client";
import { loadChannels, SlackConfigError, configErrorMessage, syncMemberChannels, type SyncOptions } from "@/server/slack/sync";

const payloadSchema = z.object({ teamId: z.string().uuid(), teamMemberId: z.string().uuid() });

export type SlackHandlerDeps = {
  /** Returns the Slack client. Defaults to one built from SLACK_BOT_TOKEN. */
  client?: () => SlackClient;
  options?: SyncOptions;
};

/**
 * Builds the slack module's job handlers. Tests inject a client backed by a mocked fetch.
 *
 * slack_membership_sync { teamId, teamMemberId }: loads the member's current status (not the
 * status at enqueue time) and applies it to every channel linked to the team.
 */
export function createSlackHandlers(deps: SlackHandlerDeps = {}): Record<string, JobHandler> {
  const getClient = deps.client ?? (() => slackClientFromEnv());

  const membershipSync: JobHandler = async (job, ctx) => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("Invalid slack_membership_sync payload");
    const { teamId, teamMemberId } = parsed.data;
    const sql = service();

    const channels = await loadChannels(sql, teamId);
    if (channels.length === 0) return { result: { channels: 0, actions: [] } };

    let client: SlackClient;
    try {
      client = getClient();
    } catch (err) {
      if (err instanceof SlackNotConfiguredError) throw new PermanentJobError(err.message);
      throw err;
    }

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
      if (err instanceof SlackConfigError) {
        throw new PermanentJobError(configErrorMessage(err.code), { errorCode: err.code });
      }
      throw err;
    }
  };

  return { slack_membership_sync: membershipSync };
}

/** Job handlers owned by the slack module. Keys are job kinds. */
export const slackHandlers: Record<string, JobHandler> = createSlackHandlers();
