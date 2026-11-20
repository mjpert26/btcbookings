"use server";

// Admin time off for any active user. Agents manage their own on the Availability page.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import type { ActionState } from "@/lib/form-state";
import { fail, isUuid, ok, requestIpHash, str } from "@/server/ui/form";
import { createTimeOff, deleteTimeOff } from "@/server/time-off";
import { timeOffFormValues, timeOffSavedState } from "@/server/time-off/form";

/** Adds a time-off block for the user in the `userId` field. Global admins only. */
export async function adminAddTimeOffAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const userId = str(fd, "userId");
  if (!isUuid(userId)) return fail("Choose a person.");
  const input = timeOffFormValues(fd);
  const ipHash = await requestIpHash();
  const res = await withUser(admin.id, (tx) => createTimeOff(tx, { actorUserId: admin.id, userId, input, ipHash }));
  if (!res.ok) return fail(res.message, res.errors);
  revalidatePath("/admin/time-off");
  return timeOffSavedState(res.block.id, res.overlapping, res.block.timezone);
}

/** Deletes any time-off block. Global admins only. */
export async function adminDeleteTimeOffAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = str(fd, "timeOffId");
  if (!isUuid(id)) return fail("Invalid time off.");
  const ipHash = await requestIpHash();
  const removed = await withUser(admin.id, (tx) => deleteTimeOff(tx, { actorUserId: admin.id, id, ipHash }));
  revalidatePath("/admin/time-off");
  // A block already deleted elsewhere (another tab or another admin) is reported as done
  // so the stale row disappears on refresh instead of failing silently.
  return ok(removed ? "Time off deleted." : "Time off was already deleted.");
}
