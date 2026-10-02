"use server";

// TODO(integration): delegate to src/server/sync/admin.ts after merge:
//   linkQueueAction        -> linkQueue(actor, teamId, queueId, queueName)
//   unlinkQueueAction      -> unlinkQueue(actor, teamId, queueId)
//   setSyncSettingsAction  -> setTeamSyncSettings(actor, teamId, { membershipSource, removalPolicy, massRemovalThresholdPct })
//   resolveAlertAction     -> resolveAlert(actor, alertId, { approveMassRemoval })
//   requestSyncNowAction   -> requestSyncNow(actor, teamId)  (calls the n8n "sync now" webhook)
// These thin versions do the database work directly with withUser + writeAudit so the
// internal UI works on its own branch.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import type { ActionState } from "@/lib/form-state";
import { fail, invalid, isUuid, ok, pgCode, requestIpHash, str } from "@/server/ui/form";
import { SF_QUEUE_ID_RE } from "@/lib/ids";

const QUEUE_ID_RE = SF_QUEUE_ID_RE;

const linkSchema = z.object({
  queueId: z.string().trim().regex(QUEUE_ID_RE, "Queue IDs start with 00G and are 15 or 18 characters."),
  queueName: z.string().trim().max(120).optional(),
});

export async function linkQueueAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  const parsed = linkSchema.safeParse({ queueId: str(fd, "queueId"), queueName: str(fd, "queueName") || undefined });
  if (!parsed.success) return invalid(parsed.error);
  const ipHash = await requestIpHash();
  try {
    await withUser(user.id, async (tx) => {
      await tx`insert into app.team_sf_queues (team_id, queue_id, queue_name) values (${teamId}, ${parsed.data.queueId}, ${parsed.data.queueName ?? null})`;
      await writeAudit(tx, { actorUserId: user.id, action: "team.queue_link", entityType: "team", entityId: teamId, after: { queueId: parsed.data.queueId }, ipHash });
    });
  } catch (err) {
    if (pgCode(err) === "23505") return fail("That queue is already linked.", { queueId: "Already linked to this team." });
    if (pgCode(err) === "23503") return fail("Team not found.");
    throw err;
  }
  revalidatePath(`/admin/teams/${teamId}/sync`);
  return ok("Queue linked. Members appear after the next sync.");
}

export async function unlinkQueueAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const queueId = str(fd, "queueId");
  if (!isUuid(teamId) || !QUEUE_ID_RE.test(queueId)) return fail("Invalid request.");
  const ipHash = await requestIpHash();
  const removed = await withUser(user.id, async (tx) => {
    const rows = await tx`delete from app.team_sf_queues where team_id = ${teamId} and queue_id = ${queueId} returning id`;
    if (rows.length) await writeAudit(tx, { actorUserId: user.id, action: "team.queue_unlink", entityType: "team", entityId: teamId, before: { queueId }, ipHash });
    return rows.length > 0;
  });
  if (!removed) return fail("Queue not found.");
  revalidatePath(`/admin/teams/${teamId}/sync`);
  return ok("Queue unlinked. Queue members are kept and paused by the next sync if no other queue includes them.");
}

const settingsSchema = z.object({
  membershipSource: z.enum(["manual", "salesforce_queue", "queue_plus_manual"]),
  removalPolicy: z.enum(["keep_bookings", "reassign"]),
  massRemovalThresholdPct: z.coerce.number().int("Use a whole number.").min(1, "1 to 100.").max(100, "1 to 100."),
});

export async function setSyncSettingsAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  const parsed = settingsSchema.safeParse({
    membershipSource: str(fd, "membershipSource"),
    removalPolicy: str(fd, "removalPolicy"),
    massRemovalThresholdPct: str(fd, "massRemovalThresholdPct"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const ipHash = await requestIpHash();
  const done = await withUser(user.id, async (tx) => {
    const [before] = await tx<{ membership_source: string; removal_policy: string; mass_removal_threshold_pct: number }[]>`
      select membership_source, removal_policy, mass_removal_threshold_pct from app.teams where id = ${teamId} for update
    `;
    if (!before) return false;
    await tx`
      update app.teams set membership_source = ${v.membershipSource}, removal_policy = ${v.removalPolicy},
        mass_removal_threshold_pct = ${v.massRemovalThresholdPct}
      where id = ${teamId}
    `;
    await writeAudit(tx, { actorUserId: user.id, action: "team.sync_settings", entityType: "team", entityId: teamId, before, after: v, ipHash });
    return true;
  });
  if (!done) return fail("Team not found.");
  revalidatePath(`/admin/teams/${teamId}/sync`);
  return ok("Sync settings saved.");
}

export async function resolveAlertAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const alertId = str(fd, "alertId");
  if (!isUuid(alertId)) return fail("Invalid alert.");
  const ipHash = await requestIpHash();
  const res = await withUser(user.id, async (tx) => {
    const [a] = await tx<{ team_id: string | null; kind: string }[]>`
      update app.sync_alerts set resolved_at = now(), resolved_by = ${user.id}
      where id = ${alertId} and resolved_at is null
      returning team_id, kind
    `;
    if (!a) return null;
    await writeAudit(tx, { actorUserId: user.id, action: "sync_alert.resolve", entityType: "sync_alert", entityId: alertId, after: { kind: a.kind }, ipHash });
    return a;
  });
  if (!res) return fail("Alert not found or already resolved.");
  if (res.team_id) revalidatePath(`/admin/teams/${res.team_id}/sync`);
  revalidatePath("/admin");
  return ok("Alert resolved.");
}

export async function requestSyncNowAction(teamId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  const ipHash = await requestIpHash();
  await withUser(user.id, (tx) => writeAudit(tx, { actorUserId: user.id, action: "team.sync_requested", entityType: "team", entityId: teamId, ipHash }));
  revalidatePath(`/admin/teams/${teamId}/sync`);
  return ok("Sync requested. The queue poller runs every 2 minutes and will apply any changes.");
}
