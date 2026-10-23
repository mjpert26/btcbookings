import { apiRoute, queryObject, readJsonBody } from "@/server/api/http";
import { listBookings, scheduleBooking } from "@/server/api/services/bookings";

export const dynamic = "force-dynamic";

/** GET /api/v1/bookings: bookings visible to the caller (agents see only their own). */
export const GET = apiRoute(({ req, caller }) => listBookings(caller, queryObject(req, ["limit", "offset"], ["mine"])));

/** POST /api/v1/bookings: schedule a meeting on an active booking page. */
export const POST = apiRoute(async ({ req, caller }) => ({ status: 201, body: { data: await scheduleBooking(caller, await readJsonBody(req)) } }));
