import { apiRoute } from "@/server/api/http";
import { getTeam } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/teams/[id]">;

export const GET = apiRoute<Ctx>(async ({ caller, ctx }) => getTeam(caller, (await ctx.params).id));
