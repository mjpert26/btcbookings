import { apiRoute } from "@/server/api/http";
import { whoAmI } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

/** GET /api/v1/me: the API key's user, role and capabilities. */
export const GET = apiRoute(({ caller }) => whoAmI(caller));
