import "server-only";
import { serviceTx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { deleteSubscription } from "@/server/graph/subscriptions";

export type DisconnectResult = { disconnected: boolean; subscriptionDeleted: boolean };

/**
 * Disconnects the user's own Outlook calendar: deletes the Graph change-notification
 * subscription (best effort), then marks the connection 'disconnected' and clears every
 * stored token and the delta link. Busy times already cached are kept until the next
 * connection replaces them. Round-robin skips the user until they reconnect, which the
 * normal sign-in flow does (status back to 'healthy').
 *
 * Runs with the service connection because app_user has no write grant on
 * calendar_connections; the caller must pass the signed-in user's own id.
 */
export async function disconnectCalendar(userId: string): Promise<DisconnectResult> {
  let subscriptionDeleted = true;
  try {
    await deleteSubscription(userId);
  } catch (err) {
    // Graph expires the subscription on its own; notifications for it fail verification once
    // the clientState hash is cleared below.
    subscriptionDeleted = false;
    console.warn(JSON.stringify({ msg: "graph subscription delete failed on disconnect", userId, error: err instanceof Error ? err.name : "unknown" }));
  }
  return serviceTx(async (tx) => {
    const [before] = await tx<{ status: string }[]>`
      select status from app.calendar_connections where user_id = ${userId} for update
    `;
    if (!before) return { disconnected: false, subscriptionDeleted };
    await tx`
      update app.calendar_connections set
        status = 'disconnected',
        access_token_enc = null,
        refresh_token_enc = null,
        token_expires_at = null,
        delta_link_enc = null,
        delta_window_start = null,
        delta_window_end = null,
        subscription_id = null,
        subscription_expires_at = null,
        client_state_hash = null,
        last_error = null,
        broken_at = null
      where user_id = ${userId}
    `;
    await writeAudit(tx, {
      actorUserId: userId,
      action: "calendar.disconnect",
      entityType: "calendar_connection",
      entityId: userId,
      before: { status: before.status },
      after: { status: "disconnected", subscriptionDeleted },
    });
    return { disconnected: true, subscriptionDeleted };
  });
}
