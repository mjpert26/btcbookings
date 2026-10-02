import "server-only";
import { z } from "zod";
import { serviceTx } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { deltaBucket, verifyClientStates } from "@/server/graph/subscriptions";

/**
 * Inbound Graph change and lifecycle notifications.
 *
 * Graph considers a notification delivered on any 2xx within 3 seconds, so handlers only
 * verify and enqueue; the work happens in jobs. Unknown subscriptions and wrong clientState
 * values are dropped without any difference in the response.
 */
export const MAX_BODY_BYTES = 1_000_000;
const MAX_VALIDATION_TOKEN_LENGTH = 2048;

const notificationSchema = z.object({
  value: z
    .array(
      z.object({
        subscriptionId: z.string().min(1).max(200),
        clientState: z.string().max(256).nullish(),
        changeType: z.string().max(50).nullish(),
        lifecycleEvent: z.string().max(50).nullish(),
      }),
    )
    .max(1000),
});

/** Handles the validation handshake. Returns null when the request is not a handshake. */
export function validationResponse(req: Request): Response | null {
  const token = new URL(req.url).searchParams.get("validationToken");
  if (token === null) return null;
  if (token.length > MAX_VALIDATION_TOKEN_LENGTH) return new Response("Bad request", { status: 400 });
  // URLSearchParams has already URL-decoded the value; Graph expects it back as plain text.
  return new Response(token, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

async function readNotifications(req: Request) {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = notificationSchema.safeParse(json);
  return parsed.success ? parsed.data.value : null;
}

const accepted = () => new Response(null, { status: 202 });
const badRequest = () => new Response("Bad request", { status: 400 });

/** POST /api/graph/notifications */
export async function handleChangeNotifications(req: Request): Promise<Response> {
  const handshake = validationResponse(req);
  if (handshake) return handshake;
  const items = await readNotifications(req);
  if (!items) return badRequest();

  const verified = await verifyClientStates(items.map((i) => ({ subscriptionId: i.subscriptionId, clientState: i.clientState })));
  const userIds = [...new Set(verified.filter((v) => v !== null).map((v) => v.userId))];
  if (userIds.length) {
    const bucket = deltaBucket();
    // Run at the end of the 30-second bucket so a burst of changes becomes one sync.
    const runAt = new Date((bucket + 1) * 30_000);
    await serviceTx(async (tx) => {
      for (const userId of userIds) {
        await enqueue(tx, { kind: "graph_delta_sync", payload: { userId }, idempotencyKey: `delta:${userId}:${bucket}`, runAt });
      }
    });
  }
  return accepted();
}

/** POST /api/graph/lifecycle */
export async function handleLifecycleNotifications(req: Request): Promise<Response> {
  const handshake = validationResponse(req);
  if (handshake) return handshake;
  const items = await readNotifications(req);
  if (!items) return badRequest();

  const verified = await verifyClientStates(items.map((i) => ({ subscriptionId: i.subscriptionId, clientState: i.clientState })));
  const now = Date.now();
  await serviceTx(async (tx) => {
    for (let i = 0; i < items.length; i++) {
      const v = verified[i];
      if (!v) continue;
      const event = items[i].lifecycleEvent;
      if (event === "reauthorizationRequired") {
        // Mark the subscription as due so the ensure job renews it (PATCH reauthorizes too).
        await tx`
          update app.calendar_connections set subscription_expires_at = now()
          where user_id = ${v.userId} and subscription_id = ${v.subscriptionId}
        `;
        await enqueue(tx, {
          kind: "graph_subscription_ensure",
          payload: { userId: v.userId },
          idempotencyKey: `ensure:${v.userId}:reauth:${Math.floor(now / 600_000)}`,
        });
      } else if (event === "subscriptionRemoved") {
        // Forget the removed subscription so the ensure job creates a new one, then catch up.
        await tx`
          update app.calendar_connections
          set subscription_id = null, subscription_expires_at = null, client_state_hash = null
          where user_id = ${v.userId} and subscription_id = ${v.subscriptionId}
        `;
        await enqueue(tx, {
          kind: "graph_subscription_ensure",
          payload: { userId: v.userId },
          idempotencyKey: `ensure:${v.userId}:removed:${v.subscriptionId}`,
        });
      } else if (event === "missed") {
        await enqueue(tx, {
          kind: "graph_delta_sync",
          payload: { userId: v.userId },
          idempotencyKey: `delta:${v.userId}:${deltaBucket(now)}`,
        });
      }
    }
  });
  return accepted();
}
