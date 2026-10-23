import { apiRoute } from "@/server/api/http";
import { listTeams } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

export const GET = apiRoute(({ caller }) => listTeams(caller));
