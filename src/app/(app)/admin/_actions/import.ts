"use server";

import { requireAdmin } from "@/server/auth/session";
import { importCalendly, type ImportReport } from "@/server/import/calendly/run";
import { snapshotSchema } from "@/server/import/calendly/map";

export type ImportState = { status: "idle" | "success" | "error"; message?: string; report?: ImportReport; ts?: number };

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Runs the Calendly import from an uploaded snapshot file. Dry run unless "apply" is checked.
 * The snapshot contains invitee contact details: it is parsed in memory and never stored.
 */
export async function importCalendlyAction(_prev: ImportState, fd: FormData): Promise<ImportState> {
  const user = await requireAdmin();
  const file = fd.get("snapshot");
  if (!(file instanceof File) || file.size === 0) return { status: "error", message: "Choose a snapshot file.", ts: Date.now() };
  if (file.size > MAX_BYTES) return { status: "error", message: "The snapshot is larger than 4 MB.", ts: Date.now() };

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return { status: "error", message: "The file is not valid JSON.", ts: Date.now() };
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { status: "error", message: `The snapshot does not match the expected format (${first?.path.join(".")}: ${first?.message}).`, ts: Date.now() };
  }

  const apply = fd.get("apply") === "on";
  const report = await importCalendly(parsed.data, { apply, actorUserId: user.id });
  return {
    status: "success",
    message: apply ? "Import applied. No emails, Outlook events or Salesforce leads were created." : "Dry run complete. Nothing was saved.",
    report,
    ts: Date.now(),
  };
}
