import { apiRoute } from "@/server/api/http";
import { removeTeamMember } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/teams/[id]/members/[memberId]">;

export const DELETE = apiRoute<Ctx>(async ({ caller, ctx }) => {
  const { id, memberId } = await ctx.params;
  await removeTeamMember(caller, id, memberId);
  return undefined;
});
