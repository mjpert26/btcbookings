import { apiRoute, readJsonBody } from "@/server/api/http";
import { updateUser } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/v1/users/[id]">;

/** PATCH { name?, role?, isActive? } (admins only). */
export const PATCH = apiRoute<Ctx>(async ({ req, caller, ctx }) => updateUser(caller, (await ctx.params).id, await readJsonBody(req)));
