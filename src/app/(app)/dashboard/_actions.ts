"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/session";
import { disconnectCalendar } from "@/server/graph/disconnect";
import type { ActionState } from "@/lib/form-state";
import { fail, ok } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";

/** Disconnects the signed-in user's own Outlook calendar (never another user's). */
export async function disconnectOutlookAction(): Promise<ActionState> {
  const user = await requireUser();
  const res = await audited(() => disconnectCalendar(user.id));
  if (!res.disconnected) return fail("No Outlook connection to disconnect.");
  revalidatePath("/", "layout");
  return ok("Outlook disconnected. Round-robin skips you until you reconnect.");
}
