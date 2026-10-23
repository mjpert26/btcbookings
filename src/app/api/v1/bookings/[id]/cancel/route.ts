import { apiRoute, readJsonBody } from "@/server/api/http";
import { cancelBooking } from "@/server/api/services/bookings";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/bookings/[id]/cancel">;

/** POST /api/v1/bookings/{id}/cancel { reason? }: cancels as the host; the invitee is notified. */
export const POST = apiRoute<Ctx>(async ({ req, caller, ctx }) => {
  const body = (await readJsonBody(req)) as { reason?: unknown };
  return cancelBooking(caller, (await ctx.params).id, typeof body.reason === "string" ? body.reason : null);
});
