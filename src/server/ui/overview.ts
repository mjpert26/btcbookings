import "server-only";
import type { Db } from "@/server/db/client";

export type AdminCounts = {
  /** app.sync_alerts with resolved_at null. */
  openSyncAlerts: number;
  /** Salesforce lead jobs (app.sf_lead_jobs) that exhausted their attempts. */
  deadSfLeadJobs: number;
  /** Lead jobs that failed and will retry. */
  failedSfLeadJobs: number;
  /** app.team_slack_channels whose health is anything but 'ok' (unknown, bot_not_in_channel, error). */
  slackChannelIssues: number;
  /** Active users whose app.calendar_connections row is 'broken' (revoked or expired consent). */
  brokenOutlookConnections: number;
};

/**
 * Counts for the admin overview. Run as an admin under withUser: every table read here has
 * an admin SELECT policy, and app.sf_lead_jobs is a security-invoker view over app.jobs.
 */
export async function loadAdminCounts(db: Db): Promise<AdminCounts> {
  const [c] = await db<AdminCounts[]>`
    select
      (select count(*)::int from app.sync_alerts where resolved_at is null) as "openSyncAlerts",
      (select count(*)::int from app.sf_lead_jobs where status = 'dead') as "deadSfLeadJobs",
      (select count(*)::int from app.sf_lead_jobs where status = 'failed') as "failedSfLeadJobs",
      (select count(*)::int from app.team_slack_channels where health <> 'ok') as "slackChannelIssues",
      (select count(*)::int from app.calendar_connections cc join app.users u on u.id = cc.user_id and u.is_active
         where cc.status = 'broken') as "brokenOutlookConnections"
  `;
  return c;
}
