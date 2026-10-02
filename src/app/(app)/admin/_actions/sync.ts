"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { createTeam, linkQueue, requestSyncNow, resolveAlert, setTeamSyncSettings, unlinkQueue, TEAM_SLUG_RE } from "@/server/sync/admin";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, ok, str } from "@/server/ui/form";
import { adminError, audited } from "@/server/ui/admin";
import { SF_QUEUE_ID_RE } from "@/lib/ids";

/**
 * Admin actions for teams and Salesforce Queue sync. Each action parses the form and
 * delegates to src/server/sync/admin.ts, which authorizes (RLS plus an admin check) and
 * writes the audit entry in the same transaction as the change.
 */

const linkSchema = z.object({
  queueId: z.string().trim().regex(SF_QUEUE_ID_RE, "Queue IDs start with 00G and are 15 or 18 characters."),
  queueName: z.string().trim().max(120).optional(),
});

export async function linkQueueAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  const parsed = linkSchema.safeParse({ queueId: str(fd, "queueId"), queueName: str(fd, "queueName") || undefined });
  if (!parsed.success) return invalid(parsed.error);
  try {
    await audited(() => linkQueue(user, teamId, parsed.data.queueId, parsed.data.queueName ?? null));
  } catch (err) {
    return adminError(err, { queueId: "Check this queue ID." });
  }
  revalidatePath(`/admin/teams/${teamId}/sync`);
  return ok("Queue linked. Members appear after the next sync.");
}

export async function unlinkQueueAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const queueId = str(fd, "queueId");
  if (!isUuid(teamId) || !SF_QUEUE_ID_RE.test(queueId)) return fail("Invalid request.");
  try {
    await audited(() => unlinkQueue(user, teamId, queueId));
  } catch (err) {
    return adminError(err);
  }
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
  try {
    await audited(() => setTeamSyncSettings(user, teamId, parsed.data));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(`/admin/teams/${teamId}/sync`);
  revalidatePath(`/teams/${teamId}`);
  return ok("Sync settings saved.");
}

export async function resolveAlertAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const alertId = str(fd, "alertId");
  if (!isUuid(alertId)) return fail("Invalid alert.");
  const approveMassRemoval = bool(fd, "approveMassRemoval");
  let res;
  try {
    res = await audited(() => resolveAlert(user, alertId, { approveMassRemoval }));
  } catch (err) {
    return adminError(err);
  }
  if (res.teamId) revalidatePath(`/admin/teams/${res.teamId}/sync`);
  revalidatePath("/admin");
  if (res.approved) return ok("Alert resolved. The next queue snapshot within 30 minutes will apply the removals.");
  return ok("Alert resolved.");
}

const SYNC_NOW_ERRORS: Record<string, string> = {
  no_linked_queues: "Link a Salesforce Queue before requesting a sync.",
  not_configured: "The n8n signing secret (N8N_SIGNING_SECRET) is not configured, so a sync cannot be requested. The poller still runs every 2 minutes.",
  network_error: "n8n could not be reached. The poller still runs every 2 minutes.",
};

export async function requestSyncNowAction(teamId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  let res;
  try {
    res = await audited(() => requestSyncNow(user, teamId));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(`/admin/teams/${teamId}/sync`);
  if (!res.ok) {
    return fail(SYNC_NOW_ERRORS[res.error] ?? `n8n did not accept the request (${res.error.replace("http_", "HTTP ")}). The poller still runs every 2 minutes.`);
  }
  return ok("Sync requested. n8n sends a fresh queue snapshot within a minute.");
}

const createTeamSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120, "Keep the name under 120 characters."),
  slug: z.string().trim().toLowerCase().regex(TEAM_SLUG_RE, "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number."),
  description: z.string().trim().max(1000, "Keep the description under 1000 characters."),
  membershipSource: z.enum(["manual", "salesforce_queue", "queue_plus_manual"], { message: "Choose a membership source." }),
});

export async function createTeamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const parsed = createTeamSchema.safeParse({
    name: str(fd, "name"),
    slug: str(fd, "slug"),
    description: str(fd, "description"),
    membershipSource: str(fd, "membershipSource"),
  });
  if (!parsed.success) return invalid(parsed.error);
  let team;
  try {
    team = await audited(() => createTeam(user, parsed.data));
  } catch (err) {
    return adminError(err, { slug: "Choose another slug." });
  }
  revalidatePath("/admin");
  revalidatePath("/teams");
  redirect(parsed.data.membershipSource === "manual" ? `/teams/${team.id}?created=1` : `/admin/teams/${team.id}/sync?created=1`);
}
