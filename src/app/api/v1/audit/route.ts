import { apiRoute, queryObject } from "@/server/api/http";
import { listAudit } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

/** GET /api/v1/audit (managers and admins). */
export const GET = apiRoute(({ req, caller }) => listAudit(caller, queryObject(req, ["limit", "offset"])));
