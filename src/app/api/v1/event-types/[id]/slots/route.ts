import { apiRoute, queryObject } from "@/server/api/http";
import { availableSlots } from "@/server/api/services/eventTypes";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/event-types/[id]/slots">;

/** GET /api/v1/event-types/{id}/slots?from=&to=&durationMin=: open start times (UTC). */
export const GET = apiRoute<Ctx>(async ({ req, caller, ctx }) => availableSlots(caller, (await ctx.params).id, queryObject(req, ["durationMin"])));
