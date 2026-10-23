import { apiRoute, readJsonBody } from "@/server/api/http";
import { changeQuestions } from "@/server/api/services/eventTypes";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/event-types/[id]/questions/[key]">;

export const PATCH = apiRoute<Ctx>(async ({ req, caller, ctx }) => {
  const { id, key } = await ctx.params;
  return changeQuestions(caller, id, { kind: "update", key, changes: await readJsonBody(req) });
});

export const DELETE = apiRoute<Ctx>(async ({ caller, ctx }) => {
  const { id, key } = await ctx.params;
  return changeQuestions(caller, id, { kind: "remove", key });
});
