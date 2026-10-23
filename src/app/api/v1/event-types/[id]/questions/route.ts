import { apiRoute, readJsonBody } from "@/server/api/http";
import { changeQuestions, getEventType } from "@/server/api/services/eventTypes";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/event-types/[id]/questions">;

export const GET = apiRoute<Ctx>(async ({ caller, ctx }) => (await getEventType(caller, (await ctx.params).id)).questions);

/** POST: add one question { question, position? }. */
export const POST = apiRoute<Ctx>(async ({ req, caller, ctx }) => {
  const body = (await readJsonBody(req)) as { question?: unknown; position?: unknown };
  const position = typeof body.position === "number" ? body.position : undefined;
  return { status: 201, body: { data: await changeQuestions(caller, (await ctx.params).id, { kind: "add", question: body.question, position }) } };
});

/** PUT: replace the whole list { questions: [...] } (also used to reorder). */
export const PUT = apiRoute<Ctx>(async ({ req, caller, ctx }) => {
  const body = (await readJsonBody(req)) as { questions?: unknown };
  return changeQuestions(caller, (await ctx.params).id, { kind: "replace", questions: body.questions });
});
