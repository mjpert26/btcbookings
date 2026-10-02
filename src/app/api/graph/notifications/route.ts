import { handleChangeNotifications } from "@/server/graph/notifications";

export const dynamic = "force-dynamic";

/** Microsoft Graph change notifications (and the subscription validation handshake). */
export async function POST(req: Request) {
  return handleChangeNotifications(req);
}
