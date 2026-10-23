import { apiRoute, readJsonBody } from "@/server/api/http";
import { ApiError, inCallerContext, invalid, requireCapability } from "@/server/api/context";
import { snapshotSchema } from "@/server/import/calendly/map";
import { importCalendly, ImportRefusedError } from "@/server/import/calendly/run";

export const dynamic = "force-dynamic";
// Large snapshots run several thousand statements in one transaction.
export const maxDuration = 300;

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/**
 * POST /api/v1/import/calendly?apply=true (admins): runs the Calendly import from a snapshot
 * in the request body, exactly like Admin > Import. Dry run unless apply=true.
 */
export const POST = apiRoute(async ({ req, caller }) => {
  requireCapability(caller, "import.manage");
  const apply = new URL(req.url).searchParams.get("apply") === "true";
  const parsed = snapshotSchema.safeParse(await readJsonBody(req, MAX_SNAPSHOT_BYTES));
  if (!parsed.success) throw invalid(parsed.error);
  try {
    return await inCallerContext(caller, () => importCalendly(parsed.data, { apply, actorUserId: caller.user.id }));
  } catch (err) {
    if (err instanceof ImportRefusedError) throw new ApiError(409, "refused", err.message);
    throw err;
  }
});
