import { apiRoute, readJsonBody } from "@/server/api/http";
import { rescheduleBooking } from "@/server/api/services/bookings";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/bookings/[id]/reschedule">;

/** POST /api/v1/bookings/{id}/reschedule { start }: moves the booking; returns the new booking. */
export const POST = apiRoute<Ctx>(async ({ req, caller, ctx }) => rescheduleBooking(caller, (await ctx.params).id, await readJsonBody(req)));
