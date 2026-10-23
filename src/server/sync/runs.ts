import "server-only";
import type { Db } from "@/server/db/client";

/**
 * Queue sync run history (app.queue_sync_runs) for the sync status view. Written with the
 * service connection inside the team's sync transaction, so a run row commits with the
 * changes it describes. Consecutive runs with the same outcome and no changes are collapsed
 * into one row so the two-minute poll does not grow the table.
 */

export type RunSource = "poll" | "push";
export type RunStatus = "applied" | "blocked" | "skipped" | "error";

export type RunRecord = {
  teamId: string;
  source: RunSource;
  status: RunStatus;
  reason?: string | null;
  snapshotId?: string | null;
  added?: number;
  removed?: number;
  reinstated?: number;
  promoted?: number;
  events?: number;
  reassignJobs?: number;
  reviewBookings?: number;
  error?: string | null;
};

/** Days a run row is kept after it was last seen. */
export const RUN_RETENTION_DAYS = 30;

const changeCount = (r: RunRecord) => (r.added ?? 0) + (r.removed ?? 0) + (r.reinstated ?? 0) + (r.promoted ?? 0) + (r.events ?? 0);

export async function recordRun(db: Db, r: RunRecord): Promise<void> {
  if (changeCount(r) === 0 && !r.error) {
    const collapsed = await db`
      update app.queue_sync_runs
      set last_seen_at = now(), repeat_count = repeat_count + 1, snapshot_id = ${r.snapshotId ?? null}
      where id = (
        select id from app.queue_sync_runs where team_id = ${r.teamId}
        order by last_seen_at desc, created_at desc limit 1
      )
        and source = ${r.source} and status = ${r.status} and reason is not distinct from ${r.reason ?? null}
        and added + removed + reinstated + promoted + events = 0 and error is null
    `;
    if (collapsed.count > 0) return;
  }
  await db`
    insert into app.queue_sync_runs
      (team_id, source, status, reason, snapshot_id, added, removed, reinstated, promoted, events,
       reassign_jobs, review_bookings, error)
    values (${r.teamId}, ${r.source}, ${r.status}, ${r.reason ?? null}, ${r.snapshotId ?? null}, ${r.added ?? 0},
            ${r.removed ?? 0}, ${r.reinstated ?? 0}, ${r.promoted ?? 0}, ${r.events ?? 0}, ${r.reassignJobs ?? 0},
            ${r.reviewBookings ?? 0}, ${r.error ?? null})
  `;
}

/** Deletes run rows not seen for RUN_RETENTION_DAYS. Returns the number removed. */
export async function purgeOldRuns(db: Db): Promise<number> {
  const res = await db`
    delete from app.queue_sync_runs where last_seen_at < now() - make_interval(days => ${RUN_RETENTION_DAYS})
  `;
  return res.count;
}
