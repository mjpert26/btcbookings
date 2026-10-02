import "server-only";
import { service } from "@/server/db/client";
import { STALE_ALERT, upsertOpenAlert } from "@/server/sync/apply";
import { NONCE_SOURCE_PUSH, NONCE_SOURCE_SNAPSHOT } from "@/server/sync/http";

export type HealthReport = { checked: number; markedStale: string[]; alertsRaised: number; noncesPurged: number };

/**
 * Marks queue-driven teams stale when no snapshot has been received for `staleMinutes`.
 *
 * "Last heard" is the latest of teams.last_synced_at and any team_sf_queues.last_snapshot_at
 * (a blocked snapshot still proves the poller is running). Teams whose queues were never
 * polled are measured from when the first queue was linked. One `sync_stale` alert is raised
 * per staleness episode; the next applied snapshot resolves it.
 */
export async function checkQueueSyncHealth(staleMinutes: number): Promise<HealthReport> {
  const sql = service();
  const teams = await sql<{ id: string; sync_health: string; last_heard_at: Date }[]>`
    select t.id, t.sync_health,
           coalesce(greatest(t.last_synced_at, max(q.last_snapshot_at)), min(q.created_at)) as last_heard_at
    from app.teams t
    join app.team_sf_queues q on q.team_id = t.id
    where t.membership_source <> 'manual'
    group by t.id
  `;
  const cutoff = Date.now() - staleMinutes * 60_000;
  const markedStale: string[] = [];
  let alertsRaised = 0;
  for (const t of teams) {
    if (new Date(t.last_heard_at).getTime() >= cutoff) continue;
    const raised = await sql.begin(async (tx) => {
      const [locked] = await tx<{ sync_health: string }[]>`
        select sync_health from app.teams where id = ${t.id} for update
      `;
      if (!locked) return false;
      const [open] = await tx`
        select 1 from app.sync_alerts where team_id = ${t.id} and kind = ${STALE_ALERT} and resolved_at is null
      `;
      await tx`
        update app.teams
        set sync_health = 'stale',
            sync_error = ${`No queue snapshot received in over ${staleMinutes} minutes.`}
        where id = ${t.id}
      `;
      if (open) return false;
      await upsertOpenAlert(tx, t.id, STALE_ALERT, {
        lastHeardAt: new Date(t.last_heard_at).toISOString(),
        staleMinutes,
        previousHealth: locked.sync_health,
      });
      return true;
    });
    markedStale.push(t.id);
    if (raised) alertsRaised++;
  }

  // Replay windows are five minutes; keep a day of nonces for diagnostics.
  const purged = await sql`
    delete from app.webhook_nonces
    where source in (${NONCE_SOURCE_SNAPSHOT}, ${NONCE_SOURCE_PUSH}) and received_at < now() - interval '1 day'
  `;
  return { checked: teams.length, markedStale, alertsRaised, noncesPurged: purged.count };
}
