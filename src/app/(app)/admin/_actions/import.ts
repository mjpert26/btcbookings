"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { importCalendly, ImportRefusedError, type ImportReport } from "@/server/import/calendly/run";
import { snapshotSchema } from "@/server/import/calendly/map";
import { CutoverForbiddenError, goLiveImportedPages, pauseImportedPages, type CutoverScope } from "@/server/import/calendly/cutover";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, pgCode, str } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";

export type ImportState = { status: "idle" | "success" | "error"; message?: string; report?: ImportReport; ts?: number };

// Below the 4 MB server action body limit (next.config.ts), which also counts multipart overhead.
const MAX_BYTES = 3.9 * 1024 * 1024;

const error = (message: string): ImportState => ({ status: "error", message, ts: Date.now() });

/**
 * Runs the Calendly import from an uploaded snapshot file. Dry run unless "apply" is checked.
 * The snapshot contains invitee contact details: it is parsed in memory and never stored or
 * logged. Database errors are reported by code and constraint name only, because Postgres
 * error details can contain row values.
 */
export async function importCalendlyAction(_prev: ImportState, fd: FormData): Promise<ImportState> {
  const user = await requireAdmin();
  const file = fd.get("snapshot");
  if (!(file instanceof File) || file.size === 0) return error("Choose a snapshot file.");
  if (file.size > MAX_BYTES) return error("The snapshot is larger than 3.9 MB.");

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return error("The file is not valid JSON.");
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return error(`The snapshot does not match the expected format (${first?.path.join(".")}: ${first?.message}).`);
  }

  const apply = fd.get("apply") === "on";
  let report: ImportReport;
  try {
    report = await audited(() => importCalendly(parsed.data, { apply, actorUserId: user.id }));
  } catch (err) {
    if (err instanceof ImportRefusedError) return error(err.message);
    const code = pgCode(err);
    const constraint = err && typeof err === "object" && "constraint_name" in err ? String((err as { constraint_name: unknown }).constraint_name) : null;
    console.error("[import] calendly import failed", { code: code ?? null, constraint });
    return error(
      code
        ? `The import failed and nothing was saved (database error ${code}${constraint ? `, ${constraint}` : ""}).`
        : "The import failed and nothing was saved.",
    );
  }
  if (apply) revalidatePath("/admin/import");
  return {
    status: "success",
    message: apply
      ? "Import applied. Imported pages are inactive until you take them live below. Nobody was notified."
      : "Dry run complete. Nothing was saved.",
    report,
    ts: Date.now(),
  };
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("team"), id: z.string().uuid() }),
  z.object({ kind: z.literal("user"), id: z.string().uuid() }),
]);

function parseScope(fd: FormData): CutoverScope | null {
  const parsed = scopeSchema.safeParse({ kind: str(fd, "kind"), id: str(fd, "id") || undefined });
  if (!parsed.success) return null;
  const s = parsed.data;
  return s.kind === "all" ? { kind: "all" } : s.kind === "team" ? { kind: "team", teamId: s.id } : { kind: "user", userId: s.id };
}

async function cutover(fd: FormData, fn: typeof goLiveImportedPages, done: (n: number) => string): Promise<ActionState> {
  const user = await requireAdmin();
  const scope = parseScope(fd);
  if (!scope) return fail("Unknown selection.");
  try {
    const n = await audited(() => fn(user, scope));
    revalidatePath("/admin/import");
    return ok(done(n));
  } catch (err) {
    if (err instanceof CutoverForbiddenError) return fail("You do not have permission to do that.");
    throw err;
  }
}

/** Activates imported pages that were active in Calendly, for one rep, one team or everything. */
export async function goLiveImportedAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return cutover(fd, goLiveImportedPages, (n) => (n ? `${n} page${n === 1 ? "" : "s"} live.` : "Nothing to take live."));
}

/** Deactivates imported pages again, for one rep, one team or everything. */
export async function pauseImportedAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return cutover(fd, pauseImportedPages, (n) => (n ? `${n} page${n === 1 ? "" : "s"} paused.` : "Nothing to pause."));
}
