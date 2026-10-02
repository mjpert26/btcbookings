import "server-only";
import { ZodError } from "zod";
import { withAuditContext } from "@/server/audit";
import type { ActionState } from "@/lib/form-state";
import { fail, requestIpHash } from "@/server/ui/form";
import { SyncAdminError } from "@/server/sync/admin";
import { SlackAdminError } from "@/server/slack/admin";
import { SlackNotConfiguredError } from "@/server/slack/client";
import { ForbiddenError, NotFoundError, SfSettingsValidationError } from "@/server/salesforce/admin";

/**
 * Runs a call into a back-end admin module with the request's ip hash attached to every
 * audit entry it writes. The modules authorize and audit; actions only parse form input,
 * delegate here and turn known errors into form messages.
 */
export async function audited<T>(fn: () => Promise<T>): Promise<T> {
  return withAuditContext({ ipHash: await requestIpHash() }, fn);
}

/** Turns a back-end message ("team admin role required") into a sentence for the UI. */
export function sentence(message: string): string {
  const text = message.trim();
  if (!text) return "Something went wrong.";
  const first = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

const FORBIDDEN = "You do not have permission to do that.";

/**
 * Maps errors thrown by the admin modules to an error state shown on the form. Unknown
 * errors are rethrown so the error boundary and server logs still see them.
 */
export function adminError(err: unknown, fieldErrors?: Record<string, string>): ActionState {
  // fieldErrors mark the offending input; they apply only to validation and conflict errors.
  if (err instanceof SyncAdminError || err instanceof SlackAdminError) {
    if (err.code === "forbidden") return fail(`${FORBIDDEN} ${sentence(err.message)}`);
    const inputProblem = ["invalid", "conflict", "invalid_input", "duplicate"].includes(err.code);
    return fail(sentence(err.message), inputProblem ? fieldErrors : undefined);
  }
  if (err instanceof ForbiddenError) return fail(`${FORBIDDEN} ${sentence(err.message)}`);
  if (err instanceof NotFoundError) return fail(sentence(err.message));
  if (err instanceof SfSettingsValidationError) return fail(sentence(err.message), fieldErrors);
  if (err instanceof SlackNotConfiguredError) {
    return fail("Slack is not configured on this deployment (SLACK_BOT_TOKEN is not set).");
  }
  if (err instanceof ZodError) return fail(sentence(err.issues.map((i) => i.message).join("; ")));
  throw err;
}
