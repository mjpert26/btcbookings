import { apiRoute, queryObject, readJsonBody } from "@/server/api/http";
import { createUser, listUsers } from "@/server/api/services/directory";

export const dynamic = "force-dynamic";

export const GET = apiRoute(({ req, caller }) => listUsers(caller, queryObject(req, ["limit", "offset"], ["active"])));

/** POST { email, name, role?, timezone? }: pre-provision a user (admins only). */
export const POST = apiRoute(async ({ req, caller }) => ({ status: 201, body: { data: await createUser(caller, await readJsonBody(req)) } }));
