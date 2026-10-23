import "server-only";
import { z } from "zod";
import { service, type Sql } from "@/server/db/client";
import { PermanentJobError, type JobContext, type JobHandler, type JobResult, type JobRow } from "@/server/jobs/types";
import { bookingById } from "@/server/booking/view";
import { loadAgentReminderData, reminderSkipReason } from "@/server/email/reminders";
import { SLACK_CONFIG_ERRORS, slackClientFromEnv, SlackNotConfiguredError, type SlackClient } from "@/server/slack/client";
import { agentReminderSlackText } from "@/server/slack/dm";
import { configErrorMessage, resolveSlackUserId, SlackConfigError } from "@/server/slack/sync";

const payloadSchema = z.object({
  template: z.literal("booking_reminder"),
  bookingId: z.uuid(),
  userId: z.uuid(),
  offsetMin: z.number().int().positive(),
});

/** Slack errors for a single DM that will not succeed on retry. */
const PERMANENT_DM_ERRORS = new Set(["channel_not_found", "user_not_found", "users_not_found", "is_archived", "msg_too_long", "no_text", "user_disabled"]);

function skip(reason: string): JobResult {
  return { result: { skipped: reason } };
}

export type SlackDmDeps = { client?: () => SlackClient; sql?: Sql; now?: number };

/**
 * slack_dm_send: a reminder posted as a direct message from the bot to a host. The Slack
 * user id is resolved by email and cached in app.slack_identities. Without
 * SLACK_BOT_TOKEN the job completes as skipped.
 */
export async function handleSlackDm(job: Pick<JobRow, "id" | "payload">, ctx: Pick<JobContext, "log">, deps: SlackDmDeps = {}): Promise<JobResult> {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError("Invalid slack_dm_send payload");
  const p = parsed.data;
  const sql = deps.sql ?? service();
  const booking = await bookingById(sql, p.bookingId);
  if (!booking) return skip("booking_not_found");
  const reason = reminderSkipReason("agent", booking, p.offsetMin, deps.now ?? Date.now());
  if (reason) return skip(reason);
  const data = await loadAgentReminderData(sql, booking, p.userId, p.offsetMin);
  if (!data) return skip("not_a_host");

  let client: SlackClient;
  try {
    client = (deps.client ?? (() => slackClientFromEnv()))();
  } catch (err) {
    if (err instanceof SlackNotConfiguredError) {
      console.info("[slack] SLACK_BOT_TOKEN not set; reminder DM not sent");
      return skip("slack_not_configured");
    }
    throw err;
  }

  let slackUserId: string | null;
  try {
    ({ slackUserId } = await resolveSlackUserId(sql, client, { userId: p.userId, email: data.hostEmail }));
  } catch (err) {
    if (err instanceof SlackConfigError) throw new PermanentJobError(configErrorMessage(err.code), { errorCode: err.code });
    throw err;
  }
  if (!slackUserId) return skip("no_slack_account");

  ctx.log({ request: { channel: "slack_dm", slackUserId } });
  const res = await client.chatPostMessage(slackUserId, agentReminderSlackText(data));
  ctx.log({ responseCode: res.ok ? 200 : 0 });
  if (!res.ok) {
    const code = res.error ?? "unknown_error";
    if (SLACK_CONFIG_ERRORS.has(code)) throw new PermanentJobError(configErrorMessage(code), { errorCode: code });
    if (PERMANENT_DM_ERRORS.has(code)) throw new PermanentJobError(`Slack chat.postMessage failed: ${code}`, { errorCode: code });
    throw new Error(`Slack chat.postMessage failed: ${code}`);
  }
  return { result: { sent: true, slackUserId } };
}

/** Builds the Slack DM handlers. Tests inject a client backed by a mocked fetch. */
export function createSlackDmHandlers(deps: SlackDmDeps = {}): Record<string, JobHandler> {
  return { slack_dm_send: (job, ctx) => handleSlackDm(job, ctx, deps) };
}

/** Job handlers for Slack direct messages. Keys are job kinds. */
export const slackDmHandlers: Record<string, JobHandler> = createSlackDmHandlers();
