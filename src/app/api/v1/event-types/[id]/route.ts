import { apiRoute, readJsonBody } from "@/server/api/http";
import { deleteEventType, getEventType, updateEventType } from "@/server/api/services/eventTypes";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/event-types/[id]">;

export const GET = apiRoute<Ctx>(async ({ caller, ctx }) => getEventType(caller, (await ctx.params).id));

/** PATCH /api/v1/event-types/{id}: change any subset of settings, including isActive. */
export const PATCH = apiRoute<Ctx>(async ({ req, caller, ctx }) => updateEventType(caller, (await ctx.params).id, await readJsonBody(req)));

/** DELETE /api/v1/event-types/{id}: only pages without bookings can be deleted. */
export const DELETE = apiRoute<Ctx>(async ({ caller, ctx }) => {
  await deleteEventType(caller, (await ctx.params).id);
  return undefined;
});
