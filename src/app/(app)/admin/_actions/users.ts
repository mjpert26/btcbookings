"use server";

// Owned by the internal UI. No back-end module replaces this.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, requestIpHash, str } from "@/server/ui/form";

const schema = z.object({ userId: z.string().uuid(), role: z.enum(["user", "admin"]) });

/**
 * Promotes or demotes a user. Demoting the last active admin is refused, which also stops
 * an admin from demoting themselves when nobody else holds the role. Demoting also removes
 * the user's admin seed so the next sign-in does not promote them again.
 */
export async function setRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const parsed = schema.safeParse({ userId: str(fd, "userId"), role: str(fd, "role") });
  if (!parsed.success) return fail("Invalid request.");
  const { userId, role } = parsed.data;
  const ipHash = await requestIpHash();

  const res = await withUser(user.id, async (tx) => {
    // Lock admin rows so two concurrent demotions cannot remove the last admin.
    const admins = await tx<{ id: string }[]>`select id from app.users where role = 'admin' and is_active for update`;
    const [target] = await tx<{ id: string; email: string; role: string; name: string }[]>`select id, email, role, name from app.users where id = ${userId}`;
    if (!target) return { error: "User not found." };
    if (target.role === role) return { message: `${target.name} is already ${role === "admin" ? "an admin" : "a standard user"}.` };
    if (role === "user" && admins.filter((a) => a.id !== userId).length === 0) {
      return { error: userId === user.id ? "You are the last admin. Promote someone else before demoting yourself." : "At least one admin must remain." };
    }
    await tx`update app.users set role = ${role} where id = ${userId}`;
    if (role === "user") await tx`delete from app.admin_seeds where email = ${target.email}`;
    await writeAudit(tx, {
      actorUserId: user.id,
      action: role === "admin" ? "user.promote_admin" : "user.demote_admin",
      entityType: "user",
      entityId: userId,
      before: { role: target.role },
      after: { role },
      ipHash,
    });
    return { message: role === "admin" ? `${target.name} is now an admin.` : `${target.name} is now a standard user.` };
  });
  if ("error" in res) return fail(res.error ?? "Could not change the role.");
  revalidatePath("/admin/users");
  return ok(res.message);
}
