import { handleLifecycleNotifications } from "@/server/graph/notifications";

export const dynamic = "force-dynamic";

/** Microsoft Graph lifecycle notifications (and the validation handshake). */
export async function POST(req: Request) {
  return handleLifecycleNotifications(req);
}
