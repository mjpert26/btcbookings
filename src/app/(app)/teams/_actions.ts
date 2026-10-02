"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { allowedEmailDomains } from "@/server/env";
import { addManualMember, manualMemberOverride, removeManualMember } from "@/server/sync/admin";
import type { ActionState } from "@/lib/form-state";
import { fail, invalid, isUuid, ok, pgCode, requestIpHash, str } from "@/server/ui/form";
import { adminError, audited } from "@/server/ui/admin";

/*
 * Roster changes (add, pause, unpause, remove) go through src/server/sync/admin.ts so that the
 * membership event, the Slack sync job, any booking reassignment and the audit entry are
 * written in one transaction, the same way for team admins, global admins and sync.
 */

async function assertTeamAdmin(tx: Tx, teamId: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`select app.is_team_admin(${teamId}) as ok`;
  return Boolean(r?.ok);
}

const addMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .max(254),
});

export async function addMemberAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(teamId)) return fail("Team not found.");
  const parsed = addMemberSchema.safeParse({ email: str(fd, "email") });
  if (!parsed.success) return invalid(parsed.error);
  const email = parsed.data.email;
  const domain = email.split("@")[1] ?? "";
  if (!allowedEmailDomains().includes(domain)) {
    return fail("Only company email addresses can be added.", { email: `Use an address at ${allowedEmailDomains().join(" or ")}.` });
  }
  let res;
  try {
    res = await audited(() => addManualMember(user, teamId, email));
  } catch (err) {
    return adminError(err, { email: "Check this address." });
  }
  revalidatePath(`/teams/${teamId}`);
  return ok(res.status === "active" ? `${email} added as an active member.` : `${email} added. They become active after signing in and connecting Outlook.`);
}

const statusSchema = z.object({ memberId: z.string().uuid(), status: z.enum(["active", "paused"]) });

export async function setMemberStatusAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = statusSchema.safeParse({ memberId: str(fd, "memberId"), status: str(fd, "status") });
  if (!parsed.success || !isUuid(teamId)) return fail("Invalid request.");
  const { memberId, status } = parsed.data;
  const note = str(fd, "note").slice(0, 500) || undefined;
  let res;
  try {
    res = await audited(() => manualMemberOverride(user, memberId, status, note, { teamId, checkOnboarding: true }));
  } catch (err) {
    return adminError(err);
  }
  if (!res.changed) return ok("No change.");
  revalidatePath(`/teams/${teamId}`);
  if (res.status === "paused") {
    return ok(
      res.reassignJobs
        ? `Member paused. Round-robin will skip them, and ${res.reassignJobs} upcoming booking${res.reassignJobs === 1 ? " is" : "s are"} being reassigned.`
        : "Member paused. Round-robin will skip them.",
    );
  }
  return ok(res.status === "active" ? "Member is active again." : "Member set to pending onboarding until they sign in and connect Outlook.");
}

export async function removeMemberAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const memberId = str(fd, "memberId");
  if (!isUuid(teamId) || !isUuid(memberId)) return fail("Invalid request.");
  try {
    await audited(() => removeManualMember(user, memberId, { teamId }));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(`/teams/${teamId}`);
  return ok("Member removed from the team.");
}

const optionalCap = z
  .union([z.literal(""), z.coerce.number().int("Use a whole number.").min(1, "Must be at least 1.").max(50, "At most 50.")])
  .transform((v) => (v === "" ? null : v));

const memberSettingsSchema = z.object({
  memberId: z.string().uuid(),
  weight: z.coerce.number().int("Use a whole number.").min(0, "0 to 1000.").max(1000, "0 to 1000."),
  priorityTier: z.coerce.number().int("Use a whole number.").min(1, "1 to 10.").max(10, "1 to 10."),
  dailyCap: optionalCap,
});

export async function updateMemberAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = memberSettingsSchema.safeParse({
    memberId: str(fd, "memberId"),
    weight: str(fd, "weight"),
    priorityTier: str(fd, "priorityTier"),
    dailyCap: str(fd, "dailyCap"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const ipHash = await requestIpHash();
  const res = await withUser(user.id, async (tx) => {
    if (!(await assertTeamAdmin(tx, teamId))) return "forbidden" as const;
    const [before] = await tx<{ weight: number; priority_tier: number; daily_cap: number | null }[]>`
      select weight, priority_tier, daily_cap from app.team_members where id = ${v.memberId} and team_id = ${teamId}
    `;
    if (!before) return "not_found" as const;
    await tx`update app.team_members set weight = ${v.weight}, priority_tier = ${v.priorityTier}, daily_cap = ${v.dailyCap} where id = ${v.memberId}`;
    await writeAudit(tx, { actorUserId: user.id, action: "team.member_update", entityType: "team_member", entityId: v.memberId, before, after: { weight: v.weight, priority_tier: v.priorityTier, daily_cap: v.dailyCap }, ipHash });
    return "ok" as const;
  });
  if (res === "forbidden") return fail("Only team admins can edit members.");
  if (res === "not_found") return fail("Member not found.");
  revalidatePath(`/teams/${teamId}`);
  return ok("Saved.");
}

const teamSettingsSchema = z.object({
  outlookConflictPolicy: z.enum(["auto_cancel", "flag"]),
  removalPolicy: z.enum(["keep_bookings", "reassign"]),
  massRemovalThresholdPct: z.coerce.number().int("Use a whole number.").min(1, "1 to 100.").max(100, "1 to 100."),
});

export async function saveTeamSettingsAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = teamSettingsSchema.safeParse({
    outlookConflictPolicy: str(fd, "outlookConflictPolicy"),
    removalPolicy: str(fd, "removalPolicy") || "keep_bookings",
    massRemovalThresholdPct: str(fd, "massRemovalThresholdPct") || "50",
  });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const ipHash = await requestIpHash();
  const res = await withUser(user.id, async (tx) => {
    const [before] = await tx<{ outlook_conflict_policy: string; removal_policy: string; mass_removal_threshold_pct: number }[]>`
      select outlook_conflict_policy, removal_policy, mass_removal_threshold_pct from app.teams where id = ${teamId}
    `;
    if (!before) return "not_found" as const;
    // Removal policy and threshold are global-admin settings (enforced by a database trigger
    // too); team admins only change the conflict policy.
    const isAdmin = user.role === "admin";
    const updated = await tx`
      update app.teams set outlook_conflict_policy = ${v.outlookConflictPolicy},
        removal_policy = ${isAdmin ? v.removalPolicy : before.removal_policy}::app.removal_policy,
        mass_removal_threshold_pct = ${isAdmin ? v.massRemovalThresholdPct : before.mass_removal_threshold_pct}
      where id = ${teamId} returning id
    `;
    if (!updated.length) return "forbidden" as const;
    await writeAudit(tx, { actorUserId: user.id, action: "team.settings_update", entityType: "team", entityId: teamId, before, after: v, ipHash });
    return "ok" as const;
  });
  if (res === "forbidden") return fail("Only team admins can change team settings.");
  if (res === "not_found") return fail("Team not found.");
  revalidatePath(`/teams/${teamId}`);
  return ok("Team settings saved.");
}

export async function addTeamAdminAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (user.role !== "admin") return fail("Only admins can manage team admins.");
  const parsed = addMemberSchema.safeParse({ email: str(fd, "email") });
  if (!parsed.success) return invalid(parsed.error);
  const ipHash = await requestIpHash();
  try {
    const res = await withUser(user.id, async (tx) => {
      const [target] = await tx<{ id: string; name: string }[]>`select id, name from app.users where email = ${parsed.data.email} and is_active`;
      if (!target) return null;
      await tx`insert into app.team_admins (team_id, user_id) values (${teamId}, ${target.id})`;
      await writeAudit(tx, { actorUserId: user.id, action: "team.admin_add", entityType: "team", entityId: teamId, after: { userId: target.id }, ipHash });
      return target.name;
    });
    if (!res) return fail("No signed-in user has that email.", { email: "The person must sign in once before they can be a team admin." });
    revalidatePath(`/teams/${teamId}`);
    return ok(`${res} is now a team admin.`);
  } catch (err) {
    if (pgCode(err) === "23505") return fail("That person is already a team admin.", { email: "Already a team admin." });
    throw err;
  }
}

export async function removeTeamAdminAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (user.role !== "admin") return fail("Only admins can manage team admins.");
  const userId = str(fd, "userId");
  if (!isUuid(userId)) return fail("Invalid request.");
  const ipHash = await requestIpHash();
  const removed = await withUser(user.id, async (tx) => {
    const rows = await tx`delete from app.team_admins where team_id = ${teamId} and user_id = ${userId} returning user_id`;
    if (rows.length) await writeAudit(tx, { actorUserId: user.id, action: "team.admin_remove", entityType: "team", entityId: teamId, before: { userId }, ipHash });
    return rows.length > 0;
  });
  if (!removed) return fail("Team admin not found.");
  revalidatePath(`/teams/${teamId}`);
  return ok("Team admin removed.");
}
