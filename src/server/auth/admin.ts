import "server-only";
import { withUser } from "@/server/db/client";
import { writeAudit } from "@/server/audit";

export class ForbiddenError extends Error {}

/**
 * Deactivates or reactivates a user. Deactivation revokes all of their sessions at once
 * and removes them from round-robin (their memberships are paused). Admin only; audited.
 */
export async function setUserActive(actor: { id: string }, userId: string, active: boolean): Promise<void> {
  await withUser(actor.id, async (tx) => {
    const [me] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
    if (!me?.ok) throw new ForbiddenError("Only admins can deactivate users.");
    if (userId === actor.id && !active) throw new ForbiddenError("You cannot deactivate yourself.");
    const [before] = await tx<{ is_active: boolean; email: string }[]>`select is_active, email from app.users where id = ${userId}`;
    if (!before) throw new ForbiddenError("User not found.");
    await tx`update app.users set is_active = ${active} where id = ${userId}`;
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: active ? "user.reactivate" : "user.deactivate",
      entityType: "user",
      entityId: userId,
      before: { isActive: before.is_active },
      after: { isActive: active },
    });
  });
  if (!active) {
    // Sessions are service-only (no app_user grant); the admin check above already passed.
    const { service } = await import("@/server/db/client");
    await service()`delete from app.sessions where user_id = ${userId}`;
  }
}
