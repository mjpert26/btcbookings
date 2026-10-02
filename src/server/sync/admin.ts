import "server-only";
import { z } from "zod";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { env } from "@/server/env";
import { NONCE_HEADER, signRequest } from "@/server/crypto/hmac";
import { randomToken } from "@/server/crypto/random";
import { MASS_REMOVAL_ALERT } from "@/server/sync/apply";
import { ADMIN_OVERRIDE_REASON, normalizeQueueId, type MemberStatus } from "@/server/sync/diff";

/**
 * Admin operations for queue sync. Every function runs inside `withUser`, so RLS applies, and
 * additionally requires `app.is_admin()` for writes. Each change writes an audit entry in the
 * same transaction. The admin UI calls these from server actions.
 */

export type Actor = { id: string; role: "user" | "admin" };

export type SyncAdminErrorCode = "forbidden" | "not_found" | "invalid" | "conflict";

export class SyncAdminError extends Error {
  constructor(readonly code: SyncAdminErrorCode, message: string) {
    super(message);
    this.name = "SyncAdminError";
  }
}

export const QUEUE_SYNC_NOW_PATH = "/webhook/btc-scheduler/queue-sync-now";
/** How long an approval of a blocked mass removal stays valid for the next snapshot. */
export const MASS_REMOVAL_APPROVAL_MINUTES = 30;

async function requireAdmin(tx: Tx): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!row?.ok) throw new SyncAdminError("forbidden", "admin role required");
}

function parseQueueId(queueId: string): string {
  const id = normalizeQueueId(queueId);
  if (!id) throw new SyncAdminError("invalid", "queue id must be a 15 or 18 character Salesforce Group id starting with 00G");
  return id;
}

// ---------------------------------------------------------------------------
// Queue links
// ---------------------------------------------------------------------------

export async function linkQueue(
  actor: Actor,
  teamId: string,
  queueId: string,
  queueName?: string | null,
): Promise<{ id: string; queueId: string }> {
  const id18 = parseQueueId(queueId);
  const name = queueName?.trim().slice(0, 200) || null;
  return withUser(actor.id, async (tx) => {
    await requireAdmin(tx);
    const [team] = await tx`select id from app.teams where id = ${teamId}`;
    if (!team) throw new SyncAdminError("not_found", "team not found");
    const rows = await tx<{ id: string }[]>`
      insert into app.team_sf_queues (team_id, queue_id, queue_name)
      values (${teamId}, ${id18}, ${name})
      on conflict (team_id, queue_id) do nothing
      returning id
    `;
    if (!rows[0]) throw new SyncAdminError("conflict", "queue already linked to this team");
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team.sf_queue.link",
      entityType: "team",
      entityId: teamId,
      after: { queueId: id18, queueName: name },
    });
    return { id: rows[0].id, queueId: id18 };
  });
}

export async function unlinkQueue(actor: Actor, teamId: string, queueId: string): Promise<void> {
  const id18 = parseQueueId(queueId);
  await withUser(actor.id, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx<{ queue_name: string | null; last_member_count: number | null }[]>`
      delete from app.team_sf_queues where team_id = ${teamId} and queue_id = ${id18}
      returning queue_name, last_member_count
    `;
    if (!rows[0]) throw new SyncAdminError("not_found", "queue link not found");
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team.sf_queue.unlink",
      entityType: "team",
      entityId: teamId,
      before: { queueId: id18, queueName: rows[0].queue_name, lastMemberCount: rows[0].last_member_count },
    });
  });
}

// ---------------------------------------------------------------------------
// Team settings
// ---------------------------------------------------------------------------

const settingsSchema = z
  .object({
    membershipSource: z.enum(["manual", "salesforce_queue", "queue_plus_manual"]).optional(),
    removalPolicy: z.enum(["keep_bookings", "reassign"]).optional(),
    massRemovalThresholdPct: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type TeamSyncSettings = z.infer<typeof settingsSchema>;

export async function setTeamSyncSettings(actor: Actor, teamId: string, settings: TeamSyncSettings): Promise<TeamSyncSettings> {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) throw new SyncAdminError("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const s = parsed.data;
  return withUser(actor.id, async (tx) => {
    await requireAdmin(tx);
    type Row = { membership_source: string; removal_policy: string; mass_removal_threshold_pct: number };
    const [before] = await tx<Row[]>`
      select membership_source, removal_policy, mass_removal_threshold_pct from app.teams where id = ${teamId} for update
    `;
    if (!before) throw new SyncAdminError("not_found", "team not found");
    const [after] = await tx<Row[]>`
      update app.teams
      set membership_source = coalesce(${s.membershipSource ?? null}::app.membership_source, membership_source),
          removal_policy = coalesce(${s.removalPolicy ?? null}::app.removal_policy, removal_policy),
          mass_removal_threshold_pct = coalesce(${s.massRemovalThresholdPct ?? null}::int, mass_removal_threshold_pct)
      where id = ${teamId}
      returning membership_source, removal_policy, mass_removal_threshold_pct
    `;
    const toSettings = (r: Row): TeamSyncSettings => ({
      membershipSource: r.membership_source as TeamSyncSettings["membershipSource"],
      removalPolicy: r.removal_policy as TeamSyncSettings["removalPolicy"],
      massRemovalThresholdPct: r.mass_removal_threshold_pct,
    });
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team.sync_settings.update",
      entityType: "team",
      entityId: teamId,
      before: toSettings(before),
      after: toSettings(after),
    });
    return toSettings(after);
  });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * Resolves a sync alert. For a `mass_removal_blocked` alert, `approveMassRemoval: true` lets the
 * next snapshot (within 30 minutes) apply even though it exceeds the safety rail.
 */
export async function resolveAlert(
  actor: Actor,
  alertId: string,
  opts: { approveMassRemoval?: boolean } = {},
): Promise<{ teamId: string | null; kind: string; approved: boolean }> {
  return withUser(actor.id, async (tx) => {
    await requireAdmin(tx);
    const [alert] = await tx<{ id: string; team_id: string | null; kind: string }[]>`
      update app.sync_alerts set resolved_at = now(), resolved_by = ${actor.id}
      where id = ${alertId} and resolved_at is null
      returning id, team_id, kind
    `;
    if (!alert) throw new SyncAdminError("not_found", "open alert not found");
    const approved = Boolean(opts.approveMassRemoval) && alert.kind === MASS_REMOVAL_ALERT && alert.team_id !== null;
    if (approved) {
      await tx`
        update app.teams
        set mass_removal_approved_until = now() + make_interval(mins => ${MASS_REMOVAL_APPROVAL_MINUTES})
        where id = ${alert.team_id}
      `;
    }
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "sync_alert.resolve",
      entityType: "sync_alert",
      entityId: alert.id,
      after: { teamId: alert.team_id, kind: alert.kind, approvedMassRemoval: approved },
    });
    return { teamId: alert.team_id, kind: alert.kind, approved };
  });
}

// ---------------------------------------------------------------------------
// Member overrides
// ---------------------------------------------------------------------------

const statusSchema = z.enum(["active", "paused", "pending_onboarding"]);

/**
 * Sets a member's status by hand. A member paused here is marked `admin_override` and is never
 * reinstated by sync; setting the member active again clears the override. A queue member set
 * active while absent from every linked queue is paused again by the next snapshot.
 */
export async function manualMemberOverride(
  actor: Actor,
  teamMemberId: string,
  status: MemberStatus,
  note?: string,
): Promise<{ changed: boolean; membershipEventId: string | null }> {
  const newStatus = statusSchema.parse(status);
  return withUser(actor.id, async (tx) => {
    await requireAdmin(tx);
    const [m] = await tx<{ id: string; team_id: string; email: string; status: MemberStatus; source: string; paused_reason: string | null }[]>`
      select id, team_id, email::text as email, status, source, paused_reason
      from app.team_members where id = ${teamMemberId} for update
    `;
    if (!m) throw new SyncAdminError("not_found", "team member not found");
    if (m.status === newStatus) return { changed: false, membershipEventId: null };
    const pausedReason = newStatus === "paused" ? ADMIN_OVERRIDE_REASON : null;
    await tx`
      update app.team_members set status = ${newStatus}, paused_reason = ${pausedReason} where id = ${m.id}
    `;
    const detail = { change: "admin_override", note: note?.slice(0, 500) ?? null, memberSource: m.source };
    const [ev] = await tx<{ id: string }[]>`
      insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, actor_user_id, detail)
      values (${m.team_id}, ${m.id}, ${m.email}, ${m.status}, ${newStatus}, 'admin', ${actor.id}, ${tx.json(detail)})
      returning id
    `;
    await tx`select app.enqueue_membership_slack_sync(${ev.id})`;
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team_member.status_override",
      entityType: "team_member",
      entityId: m.id,
      before: { status: m.status, pausedReason: m.paused_reason },
      after: { status: newStatus, pausedReason },
    });
    return { changed: true, membershipEventId: ev.id };
  });
}

// ---------------------------------------------------------------------------
// Sync now
// ---------------------------------------------------------------------------

export type SyncNowResult = { ok: true } | { ok: false; error: string };

/**
 * Asks n8n to run the queue poller now. The request is HMAC-signed with N8N_SIGNING_SECRET.
 * Global admins and the team's admins may call it. Nothing in the database changes.
 */
export async function requestSyncNow(
  actor: Actor,
  teamId: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SyncNowResult> {
  const queueIds = await withUser(actor.id, async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`select app.is_team_admin(${teamId}::uuid) as ok`;
    if (!row?.ok) throw new SyncAdminError("forbidden", "team admin role required");
    const rows = await tx<{ queue_id: string }[]>`
      select queue_id from app.team_sf_queues where team_id = ${teamId} order by queue_id
    `;
    return rows.map((r) => r.queue_id);
  });
  if (queueIds.length === 0) return { ok: false, error: "no_linked_queues" };

  const e = env();
  if (!e.N8N_SIGNING_SECRET) return { ok: false, error: "not_configured" };
  const body = JSON.stringify({ teamId, queueIds, requestedAt: new Date().toISOString() });
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(new URL(QUEUE_SYNC_NOW_PATH, e.N8N_BASE_URL).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signRequest(e.N8N_SIGNING_SECRET, body),
        [NONCE_HEADER]: randomToken(16),
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "network_error" };
  }
}
