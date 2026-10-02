import "server-only";
import { createHash } from "node:crypto";
import { service, type Tx } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import type { JobPayloads } from "@/server/jobs/kinds";
import {
  activeMembersOf,
  diffPushChange,
  diffTeamSnapshot,
  normalizeEmail,
  normalizeQueueId,
  QUEUE_REMOVAL_REASON,
  type AppUserInfo,
  type CurrentMember,
  type DiffCounts,
  type MemberChange,
  type MembershipSource,
  type QueueSnapshot,
} from "@/server/sync/diff";

/**
 * Applies queue sync results to the database (service role, RLS bypassed).
 *
 * Every team is processed in its own transaction that starts by locking the team row, so a
 * push and a poll for the same team never interleave. A failure on one team marks that team
 * `sync_health = 'error'` and does not stop the others.
 */

export type SyncSource = "poll" | "push";

export type SnapshotInput = { snapshotId: string; takenAt: string; queues: QueueSnapshot[] };

export type TeamSyncSummary = {
  teamId: string;
  status: "applied" | "blocked" | "skipped" | "error";
  reason?: string;
  counts?: DiffCounts;
  events: number;
  reassignJobs: number;
  alertId?: string;
  error?: string;
};

export type SnapshotResult = { teams: TeamSyncSummary[]; rejectedQueueIds: string[] };

type TeamRow = {
  id: string;
  membership_source: MembershipSource;
  removal_policy: "keep_bookings" | "reassign";
  mass_removal_threshold_pct: number;
  mass_removal_approved: boolean;
};

type ApplyContext = { source: SyncSource; detail: Record<string, unknown> };

export const MASS_REMOVAL_ALERT = "mass_removal_blocked";
export const STALE_ALERT = "sync_stale";

// ---------------------------------------------------------------------------
// Snapshot (poller)
// ---------------------------------------------------------------------------

export async function applySnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const sql = service();
  const snapshots = new Map<string, QueueSnapshot>();
  const rejected = new Set<string>();
  for (const q of input.queues) {
    const id = normalizeQueueId(q.queueId);
    if (!id) {
      rejected.add(q.queueId);
      continue;
    }
    const prior = snapshots.get(id);
    snapshots.set(id, { queueId: id, members: prior ? [...prior.members, ...q.members] : q.members });
  }

  const ids = [...snapshots.keys()];
  const links = ids.length
    ? await sql<{ team_id: string; queue_id: string }[]>`
        select team_id, queue_id from app.team_sf_queues where queue_id = any(${ids}::text[])
      `
    : [];
  const linked = new Set(links.map((l) => l.queue_id));
  for (const id of ids) if (!linked.has(id)) rejected.add(id);

  const teamIds = [...new Set(links.map((l) => l.team_id))].sort();
  const teams: TeamSyncSummary[] = [];
  for (const teamId of teamIds) {
    try {
      teams.push(
        await sql.begin((tx) => applySnapshotToTeam(tx, teamId, snapshots, input)) as TeamSyncSummary,
      );
    } catch (err) {
      teams.push(await recordTeamError(teamId, err));
    }
  }
  return { teams, rejectedQueueIds: [...rejected] };
}

async function applySnapshotToTeam(
  tx: Tx,
  teamId: string,
  snapshots: Map<string, QueueSnapshot>,
  input: SnapshotInput,
): Promise<TeamSyncSummary> {
  const team = await lockTeam(tx, teamId);
  const base = { teamId, events: 0, reassignJobs: 0 };
  if (!team) return { ...base, status: "skipped", reason: "team_not_found" };

  const queues = await tx<{ queue_id: string; last_member_count: number | null }[]>`
    select queue_id, last_member_count from app.team_sf_queues where team_id = ${teamId} order by queue_id
  `;
  const current = await loadMembers(tx, teamId);
  const desiredEmails = new Set<string>();
  for (const q of queues) {
    const snap = snapshots.get(q.queue_id);
    if (snap) for (const email of activeMembersOf(snap).keys()) desiredEmails.add(email);
  }
  const appUsers = await loadAppUsers(tx, [...desiredEmails]);

  const result = diffTeamSnapshot({
    team: {
      id: team.id,
      membershipSource: team.membership_source,
      massRemovalThresholdPct: team.mass_removal_threshold_pct,
      massRemovalApproved: team.mass_removal_approved,
    },
    linkedQueues: queues.map((q) => ({ queueId: q.queue_id, lastMemberCount: q.last_member_count })),
    snapshots,
    current,
    appUsers,
  });

  if (result.status === "skipped") return { ...base, status: "skipped", reason: result.reason };

  const queueIds = queues.map((q) => q.queue_id);
  if (result.status === "blocked") {
    await tx`update app.team_sf_queues set last_snapshot_at = now() where team_id = ${teamId}`;
    const detail = {
      reason: result.reason,
      thresholdPct: result.thresholdPct,
      counts: result.counts,
      emptiedQueueIds: result.emptiedQueueIds,
      snapshotId: input.snapshotId,
      takenAt: input.takenAt,
    };
    const alertId = await upsertOpenAlert(tx, teamId, MASS_REMOVAL_ALERT, detail);
    const message =
      result.reason === "empty_queue"
        ? `Sync blocked: a linked queue returned no members (${result.counts.removals} removals pending).`
        : `Sync blocked: ${result.counts.removals} of ${result.counts.currentActiveQueueMembers} queue members would be removed (threshold ${result.thresholdPct}%).`;
    await tx`update app.teams set sync_health = 'blocked', sync_error = ${message} where id = ${teamId}`;
    return { ...base, status: "blocked", reason: result.reason, counts: result.counts, alertId };
  }

  const applied = await applyChanges(tx, team, result.changes, {
    source: "poll",
    detail: { snapshotId: input.snapshotId },
  });
  for (const u of result.linkUpdates) {
    await tx`
      update app.team_members
      set user_id = coalesce(user_id, ${u.userId}), sf_user_id = ${u.sfUserId}
      where id = ${u.teamMemberId}
    `;
  }
  for (const queueId of queueIds) {
    const snap = snapshots.get(queueId)!;
    const active = [...activeMembersOf(snap).keys()].sort();
    await tx`
      update app.team_sf_queues
      set last_snapshot_at = now(), last_snapshot_hash = ${snapshotHash(snap)},
          last_member_count = ${result.queueMemberCounts[queueId] ?? 0},
          last_member_emails = ${active}::citext[]
      where team_id = ${teamId} and queue_id = ${queueId}
    `;
  }
  await tx`
    update app.teams
    set last_synced_at = now(), sync_health = 'ok', sync_error = null,
        mass_removal_approved_until = case when ${team.mass_removal_approved} then null else mass_removal_approved_until end
    where id = ${teamId}
  `;
  // A healthy sync ends any open staleness or mass-removal episode.
  await tx`
    update app.sync_alerts
    set resolved_at = now(), detail = detail || ${tx.json({ autoResolved: true })}
    where team_id = ${teamId} and resolved_at is null and kind in (${STALE_ALERT}, ${MASS_REMOVAL_ALERT})
  `;
  return { ...base, status: "applied", counts: result.counts, events: applied.events, reassignJobs: applied.reassignJobs };
}

// ---------------------------------------------------------------------------
// Push (single change)
// ---------------------------------------------------------------------------

export type PushInput = {
  eventId: string;
  action: "added" | "removed";
  queueId: string;
  sfUserId?: string | null;
  email: string;
};

export type PushResult = { linked: boolean; teams: TeamSyncSummary[] };

const PUSH_REMOVAL_WINDOW_MIN = 10;
const PUSH_REMOVAL_MIN_BUDGET = 3;

export async function applyPushChange(input: PushInput): Promise<PushResult> {
  const sql = service();
  const queueId = normalizeQueueId(input.queueId);
  if (!queueId) return { linked: false, teams: [] };
  const links = await sql<{ team_id: string }[]>`
    select team_id from app.team_sf_queues where queue_id = ${queueId} order by team_id
  `;
  const teams: TeamSyncSummary[] = [];
  for (const { team_id: teamId } of links) {
    try {
      teams.push(await sql.begin((tx) => applyPushToTeam(tx, teamId, queueId, input)) as TeamSyncSummary);
    } catch (err) {
      teams.push(await recordTeamError(teamId, err));
    }
  }
  return { linked: links.length > 0, teams };
}

async function applyPushToTeam(tx: Tx, teamId: string, queueId: string, input: PushInput): Promise<TeamSyncSummary> {
  const team = await lockTeam(tx, teamId);
  const base = { teamId, events: 0, reassignJobs: 0 };
  if (!team) return { ...base, status: "skipped", reason: "team_not_found" };
  if (team.membership_source === "manual") return { ...base, status: "skipped", reason: "manual_team" };

  const email = normalizeEmail(input.email);
  const [existing] = await loadMembers(tx, teamId, email);
  const appUsers = await loadAppUsers(tx, [email]);
  const others = await tx<{ n: number }[]>`
    select count(*)::int as n from app.team_sf_queues
    where team_id = ${teamId} and queue_id <> ${queueId} and ${email}::citext = any(last_member_emails)
  `;
  const change = diffPushChange({
    action: input.action,
    email,
    sfUserId: input.sfUserId ?? null,
    existing,
    appUser: appUsers.get(email),
    stillInOtherLinkedQueue: (others[0]?.n ?? 0) > 0,
  });

  // Keep the per-queue membership list current so later pushes evaluate other queues correctly.
  if (input.action === "added") {
    await tx`
      update app.team_sf_queues
      set last_member_emails = case when ${email}::citext = any(last_member_emails) then last_member_emails
                                    else array_append(last_member_emails, ${email}::citext) end
      where team_id = ${teamId} and queue_id = ${queueId}
    `;
  } else {
    await tx`
      update app.team_sf_queues set last_member_emails = array_remove(last_member_emails, ${email}::citext)
      where team_id = ${teamId} and queue_id = ${queueId}
    `;
  }
  await tx`
    update app.team_sf_queues set last_member_count = cardinality(last_member_emails)
    where team_id = ${teamId} and queue_id = ${queueId} and last_member_count is not null
  `;

  // Push removals bypass the snapshot safety rail one at a time, so cap how many a team can
  // take in a short window. Past the budget, removals wait for the poller, which applies its
  // full safety rail. Protects against a looping Flow or a leaked push credential.
  if (change?.kind === "remove") {
    const [{ recent, active }] = await tx<{ recent: number; active: number }[]>`
      select
        (select count(*)::int from app.membership_events
          where team_id = ${teamId} and source = 'push' and new_status = 'paused'
            and created_at > now() - make_interval(mins => ${PUSH_REMOVAL_WINDOW_MIN})) as recent,
        (select count(*)::int from app.team_members
          where team_id = ${teamId} and source = 'queue' and status in ('active', 'pending_onboarding')) as active
    `;
    const budget = Math.max(PUSH_REMOVAL_MIN_BUDGET, Math.floor((active * team.mass_removal_threshold_pct) / 100 / 2));
    if (recent >= budget) {
      const [open] = await tx<{ id: string }[]>`
        select id from app.sync_alerts
        where team_id = ${teamId} and kind = 'push_removal_budget_exceeded' and resolved_at is null limit 1
      `;
      if (!open) {
        await tx`
          insert into app.sync_alerts (team_id, kind, detail)
          values (${teamId}, 'push_removal_budget_exceeded',
                  ${tx.json({ recentPushRemovals: recent, budget, windowMinutes: PUSH_REMOVAL_WINDOW_MIN })})
        `;
      }
      return { ...base, status: "blocked", reason: "push_removal_budget_exceeded" };
    }
  }

  const applied = change
    ? await applyChanges(tx, team, [change], { source: "push", detail: { eventId: input.eventId, queueId } })
    : { events: 0, reassignJobs: 0 };
  // Single changes bypass the safety rail; record them for operators without personal data.
  console.info(
    JSON.stringify({
      msg: "queue push processed",
      teamId,
      queueId,
      action: input.action,
      change: change?.kind ?? "none",
      eventId: input.eventId,
    }),
  );
  return { ...base, status: change ? "applied" : "skipped", reason: change ? undefined : "no_change", ...applied };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function lockTeam(tx: Tx, teamId: string): Promise<TeamRow | null> {
  const rows = await tx<TeamRow[]>`
    select id, membership_source, removal_policy, mass_removal_threshold_pct,
           coalesce(mass_removal_approved_until > now(), false) as mass_removal_approved
    from app.teams where id = ${teamId}
    for update
  `;
  return rows[0] ?? null;
}

async function loadMembers(tx: Tx, teamId: string, email?: string): Promise<CurrentMember[]> {
  const rows = await tx<
    { id: string; email: string; sf_user_id: string | null; user_id: string | null; status: CurrentMember["status"]; source: CurrentMember["source"]; paused_reason: string | null }[]
  >`
    select id, email::text as email, sf_user_id, user_id, status, source, paused_reason
    from app.team_members
    where team_id = ${teamId} ${email ? tx`and email = ${email}::citext` : tx``}
    for update
  `;
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    sfUserId: r.sf_user_id,
    userId: r.user_id,
    status: r.status,
    source: r.source,
    pausedReason: r.paused_reason,
  }));
}

async function loadAppUsers(tx: Tx, emails: string[]): Promise<Map<string, AppUserInfo>> {
  const out = new Map<string, AppUserInfo>();
  if (emails.length === 0) return out;
  const rows = await tx<{ id: string; email: string; healthy: boolean }[]>`
    select u.id, lower(u.email::text) as email, coalesce(cc.status = 'healthy', false) as healthy
    from app.users u
    left join app.calendar_connections cc on cc.user_id = u.id
    where u.is_active and u.email = any(${emails}::citext[])
  `;
  for (const r of rows) out.set(r.email, { userId: r.id, calendarHealthy: r.healthy });
  return out;
}

async function applyChanges(
  tx: Tx,
  team: TeamRow,
  changes: MemberChange[],
  ctx: ApplyContext,
): Promise<{ events: number; reassignJobs: number }> {
  let events = 0;
  let reassignJobs = 0;
  for (const c of changes) {
    let memberId = c.teamMemberId;
    if (c.kind === "add") {
      const rows = await tx<{ id: string }[]>`
        insert into app.team_members (team_id, email, sf_user_id, user_id, status, source)
        values (${team.id}, ${c.email}, ${c.sfUserId}, ${c.userId}, ${c.newStatus}, 'queue')
        on conflict (team_id, email) do nothing
        returning id
      `;
      if (!rows[0]) continue;
      memberId = rows[0].id;
    } else if (c.kind === "remove") {
      await tx`
        update app.team_members set status = 'paused', paused_reason = ${QUEUE_REMOVAL_REASON}
        where id = ${memberId}
      `;
    } else {
      // Reinstatement and promotion change status only; round-robin counters are untouched.
      await tx`
        update app.team_members
        set status = ${c.newStatus}, paused_reason = null,
            user_id = coalesce(user_id, ${c.userId}), sf_user_id = coalesce(${c.sfUserId}, sf_user_id)
        where id = ${memberId}
      `;
    }

    const [ev] = await tx<{ id: string }[]>`
      insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, detail)
      values (${team.id}, ${memberId}, ${c.email}, ${c.oldStatus}, ${c.newStatus}, ${ctx.source},
              ${tx.json({ ...ctx.detail, change: c.kind } as never)})
      returning id
    `;
    events++;
    const slack: JobPayloads["slack_membership_sync"] = { teamId: team.id, teamMemberId: memberId! };
    await enqueue(tx, {
      kind: "slack_membership_sync",
      payload: slack,
      idempotencyKey: `membership_event:${ev.id}`,
      teamId: team.id,
    });

    if (c.kind === "remove" && team.removal_policy === "reassign" && c.userId) {
      reassignJobs += await enqueueReassignments(tx, team.id, c.userId, ev.id);
    }
  }
  return { events, reassignJobs };
}

/** Future confirmed bookings on the team's event types where the user is the primary host. */
async function enqueueReassignments(tx: Tx, teamId: string, userId: string, eventId: string): Promise<number> {
  const bookings = await tx<{ id: string }[]>`
    select b.id
    from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    join app.booking_hosts bh on bh.booking_id = b.id
    where et.team_id = ${teamId}
      and bh.user_id = ${userId} and bh.role = 'primary' and bh.active
      and b.status = 'confirmed' and b.start_at > now()
    order by b.start_at
  `;
  let n = 0;
  for (const b of bookings) {
    const payload: JobPayloads["booking_reassign"] = { bookingId: b.id, fromUserId: userId, reason: "removed_from_queue" };
    const id = await enqueue(tx, {
      kind: "booking_reassign",
      payload,
      idempotencyKey: `reassign:${b.id}:${eventId}`,
      bookingId: b.id,
      teamId,
    });
    if (id) n++;
  }
  return n;
}

/** Inserts an open alert of this kind for the team, or refreshes the detail of the open one. */
export async function upsertOpenAlert(tx: Tx, teamId: string, kind: string, detail: Record<string, unknown>): Promise<string> {
  const [open] = await tx<{ id: string }[]>`
    select id from app.sync_alerts where team_id = ${teamId} and kind = ${kind} and resolved_at is null
    order by created_at limit 1
  `;
  if (open) {
    await tx`
      update app.sync_alerts
      set detail = ${tx.json({ ...detail, lastSeenAt: new Date().toISOString() } as never)}
      where id = ${open.id}
    `;
    return open.id;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into app.sync_alerts (team_id, kind, detail) values (${teamId}, ${kind}, ${tx.json(detail as never)})
    returning id
  `;
  return row.id;
}

async function recordTeamError(teamId: string, err: unknown): Promise<TeamSyncSummary> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  console.error(JSON.stringify({ msg: "queue sync failed", teamId, error: message }));
  try {
    await service()`update app.teams set sync_health = 'error', sync_error = ${message} where id = ${teamId}`;
  } catch {
    // The original error is what matters; the health update is best effort.
  }
  return { teamId, status: "error", events: 0, reassignJobs: 0, error: "sync_failed" };
}

/** Stable hash of one queue snapshot (order independent). */
export function snapshotHash(snap: QueueSnapshot): string {
  const rows = snap.members
    .map((m) => `${m.sfUserId}|${normalizeEmail(m.email)}|${m.isActive ? 1 : 0}`)
    .sort();
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}
