import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { service, withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { allowedEmailDomains, env } from "@/server/env";
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

type MemberRow = {
  id: string;
  team_id: string;
  user_id: string | null;
  email: string;
  status: MemberStatus;
  source: "queue" | "manual";
  paused_reason: string | null;
};

/**
 * Loads a member row for a change and checks that the caller is a team admin of its team
 * (global admins included). A row hidden by RLS is reported as forbidden to non-admins,
 * since they cannot tell it apart from a missing one.
 */
async function lockMemberForChange(tx: Tx, teamMemberId: string, teamId?: string): Promise<MemberRow> {
  if (!z.string().uuid().safeParse(teamMemberId).success) throw new SyncAdminError("not_found", "team member not found");
  const [m] = await tx<MemberRow[]>`
    select id, team_id, user_id, email::text as email, status, source, paused_reason
    from app.team_members where id = ${teamMemberId} for update
  `;
  if (!m) {
    const [row] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
    if (!row?.ok) throw new SyncAdminError("forbidden", "team admin role required");
    throw new SyncAdminError("not_found", "team member not found");
  }
  const [ok] = await tx<{ ok: boolean }[]>`select app.is_team_admin(${m.team_id}::uuid) as ok`;
  if (!ok?.ok) throw new SyncAdminError("forbidden", "team admin role required");
  if (teamId && m.team_id !== teamId) throw new SyncAdminError("not_found", "team member not found");
  return m;
}

/**
 * Status a member gets when they are (re)activated (PLAN 4.5): active only with an active
 * app user and a healthy Outlook connection, otherwise pending_onboarding. Team admins cannot
 * read other users' calendar rows under RLS, so only the status column is read with the
 * service connection, after the caller's team-admin check.
 */
async function activationStatus(tx: Tx, userId: string | null): Promise<"active" | "pending_onboarding"> {
  if (!userId) return "pending_onboarding";
  const [u] = await tx<{ id: string }[]>`select id from app.users where id = ${userId} and is_active`;
  if (!u) return "pending_onboarding";
  const [cc] = await service()<{ status: string }[]>`select status from app.calendar_connections where user_id = ${userId}`;
  return cc?.status === "healthy" ? "active" : "pending_onboarding";
}

export type MemberOverrideOptions = {
  /** Only change a member of this team (the page the change came from). */
  teamId?: string;
  /**
   * When setting a member active, fall back to pending_onboarding if the person has not
   * signed in or has no healthy Outlook connection. The internal UI always sets this.
   */
  checkOnboarding?: boolean;
};

export type MemberOverrideResult = {
  changed: boolean;
  membershipEventId: string | null;
  status: MemberStatus;
  /** booking_reassign jobs enqueued (pause on a team with removal_policy = 'reassign'). */
  reassignJobs: number;
};

/**
 * Sets a member's status by hand. Global admins and the team's admins may call it.
 *
 * A member paused here is marked `admin_override` and is never reinstated by sync; setting
 * the member active again clears the override. A queue member set active while absent from
 * every linked queue is paused again by the next snapshot.
 *
 * Every change writes a membership event, enqueues the Slack sync job for it and writes an
 * audit entry in the same transaction. Pausing a member of a team whose removal_policy is
 * 'reassign' also enqueues booking_reassign for the member's future confirmed bookings on
 * that team (as primary host), as queue sync does for members removed from a queue.
 */
export async function manualMemberOverride(
  actor: Actor,
  teamMemberId: string,
  status: MemberStatus,
  note?: string,
  opts: MemberOverrideOptions = {},
): Promise<MemberOverrideResult> {
  const requested = statusSchema.parse(status);
  return withUser(actor.id, async (tx) => {
    const m = await lockMemberForChange(tx, teamMemberId, opts.teamId);
    const newStatus: MemberStatus =
      requested === "active" && opts.checkOnboarding ? await activationStatus(tx, m.user_id) : requested;
    if (m.status === newStatus) return { changed: false, membershipEventId: null, status: m.status, reassignJobs: 0 };
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
    let reassignJobs = 0;
    if (newStatus === "paused") {
      const [r] = await tx<{ n: number }[]>`select app.enqueue_member_reassignments(${ev.id}) as n`;
      reassignJobs = r?.n ?? 0;
    }
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team_member.status_override",
      entityType: "team_member",
      entityId: m.id,
      before: { status: m.status, pausedReason: m.paused_reason },
      after: { status: newStatus, pausedReason, reassignJobs },
    });
    return { changed: true, membershipEventId: ev.id, status: newStatus, reassignJobs };
  });
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Adds a manual member to a team. Global admins and the team's admins may call it. The
 * member starts active when the person has signed in with a healthy Outlook connection,
 * otherwise pending_onboarding (activated at their next sign-in). Teams whose roster only
 * mirrors Salesforce Queues do not take manual members.
 */
export async function addManualMember(
  actor: Actor,
  teamId: string,
  email: string,
): Promise<{ teamMemberId: string; status: MemberStatus; membershipEventId: string }> {
  if (!z.string().uuid().safeParse(teamId).success) throw new SyncAdminError("not_found", "team not found");
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) throw new SyncAdminError("invalid", "enter a valid email address");
  const address = parsed.data;
  const domains = allowedEmailDomains();
  if (!domains.includes(address.split("@")[1] ?? "")) {
    throw new SyncAdminError("invalid", `only company email addresses can be added (${domains.join(", ")})`);
  }
  try {
    return await withUser(actor.id, async (tx) => {
      const [ok] = await tx<{ ok: boolean }[]>`select app.is_team_admin(${teamId}::uuid) as ok`;
      if (!ok?.ok) throw new SyncAdminError("forbidden", "team admin role required");
      const [team] = await tx<{ membership_source: string }[]>`select membership_source from app.teams where id = ${teamId}`;
      if (!team) throw new SyncAdminError("not_found", "team not found");
      if (team.membership_source === "salesforce_queue") {
        throw new SyncAdminError(
          "invalid",
          "this team's roster mirrors its Salesforce Queues; set the membership source to queue plus manual to add people by hand",
        );
      }
      const [target] = await tx<{ id: string }[]>`select id from app.users where email = ${address}`;
      const status = await activationStatus(tx, target?.id ?? null);
      const [m] = await tx<{ id: string }[]>`
        insert into app.team_members (team_id, user_id, email, status, source)
        values (${teamId}, ${target?.id ?? null}, ${address}, ${status}, 'manual')
        returning id
      `;
      const [ev] = await tx<{ id: string }[]>`
        insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, actor_user_id, detail)
        values (${teamId}, ${m.id}, ${address}, null, ${status}, 'admin', ${actor.id}, ${tx.json({ change: "add_manual_member" })})
        returning id
      `;
      await tx`select app.enqueue_membership_slack_sync(${ev.id})`;
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "team_member.add",
        entityType: "team_member",
        entityId: m.id,
        after: { teamId, email: address, status, source: "manual" },
      });
      return { teamMemberId: m.id, status, membershipEventId: ev.id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new SyncAdminError("conflict", "that person is already on this team");
    throw err;
  }
}

/**
 * Removes a manual member from a team. Global admins and the team's admins may call it.
 * Queue members can only be paused (sync owns them), and a member who still hosts future
 * bookings on the team's event types must be paused, or the bookings moved, first. The
 * membership event is written and the Slack job enqueued before the row is deleted, so the
 * Slack sync treats the member as removed.
 */
export async function removeManualMember(
  actor: Actor,
  teamMemberId: string,
  opts: { teamId?: string } = {},
): Promise<{ membershipEventId: string }> {
  return withUser(actor.id, async (tx) => {
    const m = await lockMemberForChange(tx, teamMemberId, opts.teamId);
    if (m.source !== "manual") throw new SyncAdminError("invalid", "queue members cannot be removed; pause them instead");
    const [future] = await tx<{ n: number }[]>`
      select count(distinct b.id)::int as n
      from app.booking_hosts bh
      join app.bookings b on b.id = bh.booking_id
      join app.event_types et on et.id = b.event_type_id
      where et.team_id = ${m.team_id} and bh.active
        and (bh.team_member_id = ${m.id} ${m.user_id ? tx`or bh.user_id = ${m.user_id}` : tx``})
        and b.status in ('confirmed', 'flagged') and b.start_at > now()
    `;
    const upcoming = future?.n ?? 0;
    if (upcoming > 0) {
      throw new SyncAdminError(
        "conflict",
        `this member hosts ${upcoming} upcoming booking${upcoming === 1 ? "" : "s"} on this team; pause them instead, or cancel or move the bookings first`,
      );
    }
    const detail = { change: "removed", team_member_id: m.id, memberSource: m.source };
    const [ev] = await tx<{ id: string }[]>`
      insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, actor_user_id, detail)
      values (${m.team_id}, ${m.id}, ${m.email}, ${m.status}, null, 'admin', ${actor.id}, ${tx.json(detail)})
      returning id
    `;
    await tx`select app.enqueue_membership_slack_sync(${ev.id})`;
    await tx`delete from app.team_members where id = ${m.id}`;
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team_member.remove",
      entityType: "team_member",
      entityId: m.id,
      before: { teamId: m.team_id, email: m.email, status: m.status, source: m.source },
    });
    return { membershipEventId: ev.id };
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Same rule as the teams.slug check constraint. */
export const TEAM_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

const createTeamSchema = z
  .object({
    name: z.string().trim().min(1, "enter a name").max(120, "keep the name under 120 characters"),
    slug: z.string().trim().toLowerCase().regex(TEAM_SLUG_RE, "use lowercase letters, numbers and hyphens (up to 64 characters)"),
    description: z
      .string()
      .trim()
      .max(1000, "keep the description under 1000 characters")
      .nullish()
      .transform((v) => (v ? v : null)),
    membershipSource: z.enum(["manual", "salesforce_queue", "queue_plus_manual"]).default("manual"),
  })
  .strict();

export type CreateTeamInput = z.input<typeof createTeamSchema>;

/** Creates a team. Global admins only. Queue links and Slack channels are added afterwards. */
export async function createTeam(actor: Actor, input: CreateTeamInput): Promise<{ id: string; slug: string }> {
  const parsed = createTeamSchema.safeParse(input);
  if (!parsed.success) throw new SyncAdminError("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const t = parsed.data;
  const id = randomUUID();
  try {
    await withUser(actor.id, async (tx) => {
      await requireAdmin(tx);
      await tx`
        insert into app.teams (id, name, slug, description, membership_source)
        values (${id}, ${t.name}, ${t.slug}, ${t.description}, ${t.membershipSource})
      `;
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "team.create",
        entityType: "team",
        entityId: id,
        after: { name: t.name, slug: t.slug, description: t.description, membershipSource: t.membershipSource },
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new SyncAdminError("conflict", "a team with that slug already exists");
    throw err;
  }
  return { id, slug: t.slug };
}

// ---------------------------------------------------------------------------
// Sync now
// ---------------------------------------------------------------------------

export type SyncNowResult = { ok: true } | { ok: false; error: string };

/**
 * Asks n8n to run the queue poller now. The request is HMAC-signed with N8N_SIGNING_SECRET.
 * Global admins and the team's admins may call it. The roster itself is not changed here; the
 * request and its outcome are recorded in the audit log.
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
  const result = await sendSyncNow(teamId, queueIds, opts);
  await withUser(actor.id, (tx) =>
    writeAudit(tx, {
      actorUserId: actor.id,
      action: "team.sync_now_requested",
      entityType: "team",
      entityId: teamId,
      after: { queueIds, ...result },
    }),
  );
  return result;
}

async function sendSyncNow(
  teamId: string,
  queueIds: string[],
  opts: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<SyncNowResult> {
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
