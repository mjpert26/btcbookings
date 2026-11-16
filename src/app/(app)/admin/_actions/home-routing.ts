"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/server/auth/session";
import { bookField, HomeRoutingError, saveHomeRouting, testHomeRouting, type HomeRoutingTestResult } from "@/server/home/admin";
import { RENEWAL_BOOKS } from "@/lib/home-routing";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, str } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";

/**
 * Admin > Home page. The actions parse the form and delegate to src/server/home/admin.ts,
 * which checks the admin role under row-level security and writes the audit entry in the same
 * transaction as the change.
 */

const PATH = "/admin/home-routing";

function homeRoutingError(err: unknown): ActionState {
  if (err instanceof HomeRoutingError) {
    return err.code === "forbidden" ? fail("You do not have permission to do that.") : fail(err.message, err.fieldErrors);
  }
  throw err;
}

export async function saveHomeRoutingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const raw = fd.get("excludedOwnerEmails");
  try {
    await audited(() =>
      saveHomeRouting(user, {
        newBusinessEventTypeId: str(fd, "newBusinessEventTypeId"),
        renewalDefaultEventTypeId: str(fd, "renewalDefaultEventTypeId"),
        renewalBooks: Object.fromEntries(RENEWAL_BOOKS.map((b) => [b, str(fd, bookField(b))])) as Record<(typeof RENEWAL_BOOKS)[number], string>,
        excludedOwnerEmails: typeof raw === "string" ? raw : "",
      }),
    );
  } catch (err) {
    return homeRoutingError(err);
  }
  revalidatePath(PATH);
  return ok("Home page routing saved.");
}

export type HomeRoutingTestState = ActionState & { result?: HomeRoutingTestResult };

/** Runs the visitor lookup for one email and shows the decision. Changes nothing. */
export async function testHomeRoutingAction(_prev: HomeRoutingTestState, fd: FormData): Promise<HomeRoutingTestState> {
  const user = await requireAdmin();
  try {
    const result = await audited(() => testHomeRouting(user, str(fd, "email")));
    return { ...ok("Lookup finished."), result };
  } catch (err) {
    return homeRoutingError(err);
  }
}
