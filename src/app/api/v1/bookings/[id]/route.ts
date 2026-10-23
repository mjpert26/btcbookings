import { apiRoute } from "@/server/api/http";
import { getBooking } from "@/server/api/services/bookings";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/bookings/[id]">;

export const GET = apiRoute<Ctx>(async ({ caller, ctx }) => getBooking(caller, (await ctx.params).id));
