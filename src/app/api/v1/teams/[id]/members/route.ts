import { apiRoute, readJsonBody } from "@/server/api/http";
import { addTeamMember } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/teams/[id]/members">;

/** POST { email }: add a rep to the team (team admins and admins). */
export const POST = apiRoute<Ctx>(async ({ req, caller, ctx }) => ({ status: 201, body: { data: await addTeamMember(caller, (await ctx.params).id, await readJsonBody(req)) } }));
