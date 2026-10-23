import { apiRoute, queryObject, readJsonBody } from "@/server/api/http";
import { createEventType, listEventTypes } from "@/server/api/services/eventTypes";

export const dynamic = "force-dynamic";

/** GET /api/v1/event-types: booking pages visible to the caller. */
export const GET = apiRoute(({ req, caller }) => listEventTypes(caller, queryObject(req, ["limit", "offset"], ["active", "mine"])));

/** POST /api/v1/event-types: create a booking page (for yourself, a team you manage, or anyone as an admin). */
export const POST = apiRoute(async ({ req, caller }) => ({ status: 201, body: { data: await createEventType(caller, await readJsonBody(req)) } }));
