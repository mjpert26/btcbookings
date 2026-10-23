"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCapability } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { withAuditContext } from "@/server/audit";
import { setErrorResolved } from "@/server/errors/admin";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, pgCode, requestIpHash, str } from "@/server/ui/form";

const schema = z.object({ id: z.string().uuid(), resolved: z.enum(["true", "false"]) });

/** Resolves or reopens an error log entry. Audited as error.resolve or error.reopen. */
export async function setErrorResolvedAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireCapability("errors.read");
  const parsed = schema.safeParse({ id: str(fd, "id"), resolved: str(fd, "resolved") });
  if (!parsed.success) return fail("Invalid request.");
  const resolved = parsed.data.resolved === "true";
  const ipHash = await requestIpHash();

  let res;
  try {
    res = await withAuditContext({ ipHash, via: "web" }, () => withUser(user.id, (tx) => setErrorResolved(tx, user.id, parsed.data.id, resolved)));
  } catch (err) {
    // A new occurrence opened an entry with the same fingerprint while this one was being reopened.
    if (pgCode(err) === "23505") return fail("This error has happened again since it was resolved. The newer entry is already open.");
    throw err;
  }
  if (!res.ok) return fail(res.error);
  revalidatePath("/admin/errors");
  if (!res.changed) return ok(resolved ? "Already resolved." : "Already open.");
  return ok(resolved ? "Marked as resolved." : "Reopened.");
}
