import "server-only";
import type { Db } from "@/server/db/client";

/**
 * Read models for the sync status view (/admin/sync and the team's queue sync page).
 * Call inside withUser for a global admin: the job counts read app.jobs, which only admins
 * can see under RLS.
 */

export const SLACK_JOB_KINDS = ["slack_membership_sync", "slack_usergroup_sync"] as const;

export type SyncRun = {
  source: "poll" | "push";
  status: "applied" | "blocked" | "skipped" | "error";
  reason: string | null;
  added: number;
  removed: number;
  reinstated: number;
  promoted: number;
  reassign_jobs: number;
  review_bookings: number;
  error: string | null;
  repeat_count: number;
  created_at: Date;
  last_seen_at: Date;
};

export type TeamSyncStatus = {
  teamId: string;
  name: string;
  membershipSource: string;
  removalPolicy: string;
  syncHealth: string;
  syncError: string | null;
  lastSyncedAt: Date | null;
  lastSnapshotAt: Date | null;
  queues: number;
  slackChannels: number;
  slackUsergroup: { usergroupId: string; handle: string | null; dryRun: boolean; health: string } | null;
  /** The most recent run, whatever its outcome. */
  lastRun: SyncRun | null;
  /** The most recent run that changed the roster. */
  lastChangeRun: SyncRun | null;
  slackJobs: { pending: number; retrying: number; dead: number };
  openAlerts: number;
  /** Current errors: queue sync, Slack channels, Slack user group and failed Slack jobs. */
  errors: string[];
};

export type SyncOverview = { teams: TeamSyncStatus[]; unlinkedTeams: number };

type TeamRow = {
  id: string;
  name: string;
  membership_source: string;
  removal_policy: string;
  sync_health: string;
  sync_error: string | null;
  last_synced_at: Date | null;
  last_snapshot_at: Date | null;
  queues: number;
  channels: number;
  channel_errors: string[] | null;
  ug_id: string | null;
  ug_handle: string | null;
  ug_dry_run: boolean | null;
  ug_health: string | null;
  ug_error: string | null;
  pending: number;
  retrying: number;
  dead: number;
  job_errors: string[] | null;
  open_alerts: number;
};

const RUN_COLUMNS = [
  "source", "status", "reason", "added", "removed", "reinstated", "promoted", "reassign_jobs", "review_bookings", "error",
  "repeat_count", "created_at", "last_seen_at",
];

/**
 * Sync status per team. Without a teamId, only teams with a Salesforce Queue or a Slack link
 * are listed; teams with neither (for example the teams imported from Calendly) run no sync
 * or Slack work and are only counted.
 */
export async function loadSyncStatus(db: Db, opts: { teamId?: string } = {}): Promise<SyncOverview> {
  const kinds = [...SLACK_JOB_KINDS];
  const rows = await db<TeamRow[]>`
    select t.id, t.name, t.membership_source::text as membership_source, t.removal_policy::text as removal_policy,
           t.sync_health, t.sync_error, t.last_synced_at,
           (select max(q.last_snapshot_at) from app.team_sf_queues q where q.team_id = t.id) as last_snapshot_at,
           (select count(*)::int from app.team_sf_queues q where q.team_id = t.id) as queues,
           (select count(*)::int from app.team_slack_channels c where c.team_id = t.id) as channels,
           (select array_agg(coalesce(c.channel_name, c.channel_id) || ': ' || coalesce(c.last_error, c.health::text) order by c.created_at)
              from app.team_slack_channels c where c.team_id = t.id and c.health in ('error', 'bot_not_in_channel')) as channel_errors,
           ug.usergroup_id as ug_id, ug.usergroup_handle as ug_handle, ug.dry_run as ug_dry_run,
           ug.health::text as ug_health, ug.last_error as ug_error,
           (select count(*)::int from app.jobs j where j.team_id = t.id and j.kind = any(${kinds}) and j.status in ('pending', 'running')) as pending,
           (select count(*)::int from app.jobs j where j.team_id = t.id and j.kind = any(${kinds}) and j.status = 'failed') as retrying,
           (select count(*)::int from app.jobs j where j.team_id = t.id and j.kind = any(${kinds}) and j.status = 'dead') as dead,
           (select array_agg(e.msg) from (
              select j.kind || ': ' || j.last_error as msg from app.jobs j
              where j.team_id = t.id and j.kind = any(${kinds}) and j.status in ('failed', 'dead') and j.last_error is not null
              order by j.updated_at desc limit 3) e) as job_errors,
           (select count(*)::int from app.sync_alerts a where a.team_id = t.id and a.resolved_at is null) as open_alerts
    from app.teams t
    left join app.team_slack_usergroups ug on ug.team_id = t.id
    where ${opts.teamId ? db`t.id = ${opts.teamId}` : db`true`}
    order by t.name, t.id
  `;
  const linked = opts.teamId ? rows : rows.filter((r) => r.queues > 0 || r.channels > 0 || r.ug_id !== null);
  const teams: TeamSyncStatus[] = [];
  for (const r of linked) {
    const [lastRun] = await db<SyncRun[]>`
      select ${db(RUN_COLUMNS)} from app.queue_sync_runs where team_id = ${r.id}
      order by last_seen_at desc, created_at desc limit 1
    `;
    const [lastChangeRun] = await db<SyncRun[]>`
      select ${db(RUN_COLUMNS)} from app.queue_sync_runs
      where team_id = ${r.id} and added + removed + reinstated + promoted > 0
      order by created_at desc limit 1
    `;
    const errors: string[] = [];
    if (r.sync_error && r.sync_health !== "ok") errors.push(`Queue sync: ${r.sync_error}`);
    for (const e of r.channel_errors ?? []) errors.push(`Slack channel ${e}`);
    if (r.ug_id && (r.ug_health === "error" || r.ug_error)) errors.push(`Slack user group: ${r.ug_error ?? r.ug_health}`);
    for (const e of r.job_errors ?? []) errors.push(`Job ${e}`);
    teams.push({
      teamId: r.id,
      name: r.name,
      membershipSource: r.membership_source,
      removalPolicy: r.removal_policy,
      syncHealth: r.sync_health,
      syncError: r.sync_error,
      lastSyncedAt: r.last_synced_at,
      lastSnapshotAt: r.last_snapshot_at,
      queues: r.queues,
      slackChannels: r.channels,
      slackUsergroup: r.ug_id ? { usergroupId: r.ug_id, handle: r.ug_handle, dryRun: Boolean(r.ug_dry_run), health: r.ug_health ?? "unknown" } : null,
      lastRun: lastRun ?? null,
      lastChangeRun: lastChangeRun ?? null,
      slackJobs: { pending: r.pending, retrying: r.retrying, dead: r.dead },
      openAlerts: r.open_alerts,
      errors,
    });
  }
  return { teams, unlinkedTeams: rows.length - linked.length };
}

export type ReviewBooking = {
  bookingId: string;
  startAt: Date;
  status: string;
  eventTypeName: string;
  hostName: string;
  memberStatus: string;
  pausedReason: string | null;
  imported: boolean;
};

/**
 * Upcoming confirmed or flagged bookings on the team's booking pages whose active host is a
 * paused member of the team: bookings kept by removal_policy 'keep_bookings', imported
 * bookings, and bookings a reassignment could not move. Admins review these by hand.
 */
export async function loadReviewBookings(db: Db, teamId: string, limit = 50): Promise<ReviewBooking[]> {
  const rows = await db<{
    booking_id: string;
    start_at: Date;
    status: string;
    event_type_name: string;
    host_name: string;
    member_status: string;
    paused_reason: string | null;
    imported: boolean;
  }[]>`
    select distinct on (b.start_at, b.id, u.id)
           b.id as booking_id, b.start_at, b.status::text as status, et.name as event_type_name, u.name as host_name,
           tm.status::text as member_status, tm.paused_reason, b.import_source is not null as imported
    from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    join app.booking_hosts bh on bh.booking_id = b.id and bh.active
    join app.users u on u.id = bh.user_id
    join app.team_members tm on tm.team_id = et.team_id and tm.user_id = bh.user_id
    where et.team_id = ${teamId} and tm.status = 'paused'
      and b.status in ('confirmed', 'flagged') and b.start_at > now()
    order by b.start_at, b.id, u.id
    limit ${limit}
  `;
  return rows.map((r) => ({
    bookingId: r.booking_id,
    startAt: r.start_at,
    status: r.status,
    eventTypeName: r.event_type_name,
    hostName: r.host_name,
    memberStatus: r.member_status,
    pausedReason: r.paused_reason,
    imported: r.imported,
  }));
}
