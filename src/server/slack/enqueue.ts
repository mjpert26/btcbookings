import "server-only";
import type { Db } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import type { JobPayloads } from "@/server/jobs/kinds";

export type SlackJobIds = { channels: string | null; usergroup: string | null };

/**
 * Enqueues the Slack work for one membership change, inside the caller's transaction:
 * slack_membership_sync when the team has a Slack channel linked, and slack_usergroup_sync
 * when it has a Slack user group linked. Teams without Slack links get no jobs. Both jobs
 * share the idempotency key (unique per kind), normally `membership_event:<event id>`.
 *
 * The SQL function app.enqueue_membership_slack_sync() applies the same rule for changes
 * made by team admins through RLS-bound connections.
 */
export async function enqueueMemberSlackJobs(
  db: Db,
  input: { teamId: string; teamMemberId: string; idempotencyKey: string },
): Promise<SlackJobIds> {
  const [links] = await db<{ channels: boolean; usergroup: boolean }[]>`
    select exists (select 1 from app.team_slack_channels where team_id = ${input.teamId}) as channels,
           exists (select 1 from app.team_slack_usergroups where team_id = ${input.teamId}) as usergroup
  `;
  const payload: JobPayloads["slack_membership_sync"] = { teamId: input.teamId, teamMemberId: input.teamMemberId };
  const out: SlackJobIds = { channels: null, usergroup: null };
  if (links?.channels) {
    out.channels = await enqueue(db, { kind: "slack_membership_sync", payload, idempotencyKey: input.idempotencyKey, teamId: input.teamId });
  }
  if (links?.usergroup) {
    out.usergroup = await enqueue(db, { kind: "slack_usergroup_sync", payload, idempotencyKey: input.idempotencyKey, teamId: input.teamId });
  }
  return out;
}
