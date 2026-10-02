import "server-only";
import { service, type Db } from "@/server/db/client";
import { env } from "@/server/env";
import { randomToken, safeEqual, sha256Hex } from "@/server/crypto/random";
import { graphClient, isGraphStatus } from "@/server/graph/client";
import { CalendarConnectionBroken } from "@/server/graph/tokens";
import { enqueue } from "@/server/jobs/queue";

/**
 * Graph change-notification subscriptions on each user's /me/events.
 *
 * clientState: 32 random bytes (base64url, 43 characters; Graph allows up to 128). Only the
 * SHA-256 hash is stored, in calendar_connections.client_state_hash. Verification hashes the
 * received value and compares hashes in constant time. The plaintext is never needed again:
 * renewal is a PATCH of expirationDateTime only, and a recreated subscription gets a new
 * clientState.
 */
export const SUBSCRIPTION_RESOURCE = "me/events";
export const SUBSCRIPTION_CHANGE_TYPES = "created,updated,deleted";
/** Outlook event subscriptions (basic notifications) allow at most 10,080 minutes. */
export const MAX_LIFETIME_MINUTES = 10_080;
/** Requested lifetime: the maximum minus a small margin for clock skew. */
export const REQUESTED_LIFETIME_MINUTES = MAX_LIFETIME_MINUTES - 15;
/** Subscriptions expiring sooner than this are renewed. */
export const RENEW_WITHIN_MS = 48 * 3600_000;

export const notificationUrl = () => `${env().APP_BASE_URL}/api/graph/notifications`;
export const lifecycleNotificationUrl = () => `${env().APP_BASE_URL}/api/graph/lifecycle`;

type SubscriptionResponse = { id: string; expirationDateTime: string; resource?: string; notificationUrl?: string };

export type EnsureOutcome = "unchanged" | "renewed" | "created";

function expiry(now = Date.now()): string {
  return new Date(now + REQUESTED_LIFETIME_MINUTES * 60_000).toISOString();
}

async function loadConnection(userId: string) {
  const [conn] = await service()<
    { status: string; subscription_id: string | null; subscription_expires_at: Date | null }[]
  >`select status, subscription_id, subscription_expires_at from app.calendar_connections where user_id = ${userId}`;
  if (!conn) throw new CalendarConnectionBroken(userId, "No Outlook connection");
  if (conn.status !== "healthy") throw new CalendarConnectionBroken(userId, `Outlook connection is ${conn.status}`);
  return conn;
}

/**
 * Creates the subscription if missing, renews it when it expires within 48 hours, and
 * recreates it when Graph no longer knows it. Safe to call repeatedly.
 */
export async function ensureSubscription(userId: string, opts: { forceRenew?: boolean } = {}): Promise<EnsureOutcome> {
  const conn = await loadConnection(userId);
  const client = graphClient(userId);

  if (conn.subscription_id) {
    const expiresAt = conn.subscription_expires_at?.getTime() ?? 0;
    if (!opts.forceRenew && expiresAt - Date.now() > RENEW_WITHIN_MS) return "unchanged";
    try {
      const res = await client.patch<SubscriptionResponse>(`/subscriptions/${encodeURIComponent(conn.subscription_id)}`, {
        expirationDateTime: expiry(),
      });
      await service()`
        update app.calendar_connections
        set subscription_expires_at = ${new Date(res.data.expirationDateTime)}, subscription_renewed_at = now()
        where user_id = ${userId} and subscription_id = ${conn.subscription_id}
      `;
      return "renewed";
    } catch (err) {
      if (!isGraphStatus(err, 404)) throw err;
      // Graph removed it (expired or revoked). Fall through and create a new one.
    }
  }

  await createSubscription(userId);
  return "created";
}

async function createSubscription(userId: string): Promise<void> {
  const client = graphClient(userId);
  const clientState = randomToken(32);
  const body = {
    changeType: SUBSCRIPTION_CHANGE_TYPES,
    notificationUrl: notificationUrl(),
    lifecycleNotificationUrl: lifecycleNotificationUrl(),
    resource: SUBSCRIPTION_RESOURCE,
    expirationDateTime: expiry(),
    clientState,
  };
  let created: SubscriptionResponse;
  try {
    created = (await client.post<SubscriptionResponse>("/subscriptions", body)).data;
  } catch (err) {
    if (!isGraphStatus(err, 409)) throw err;
    // A subscription for the same resource and change types already exists (its id was lost,
    // e.g. after a crash). Remove the app's stale ones for this user and create again.
    await deleteStaleSubscriptions(userId);
    created = (await client.post<SubscriptionResponse>("/subscriptions", body)).data;
  }
  await service()`
    update app.calendar_connections set
      subscription_id = ${created.id},
      subscription_expires_at = ${new Date(created.expirationDateTime)},
      client_state_hash = ${sha256Hex(clientState)},
      subscription_renewed_at = now()
    where user_id = ${userId}
  `;
  // Changes made while there was no subscription are picked up by a delta sync.
  await enqueue(service(), {
    kind: "graph_delta_sync",
    payload: { userId },
    idempotencyKey: `delta:${userId}:${deltaBucket()}`,
  });
}

async function deleteStaleSubscriptions(userId: string): Promise<void> {
  const client = graphClient(userId);
  const res = await client.get<{ value?: SubscriptionResponse[] }>("/subscriptions");
  const ours = (res.data?.value ?? []).filter(
    (s) => s.notificationUrl === notificationUrl() && (s.resource ?? "").replace(/^\//, "").toLowerCase() === SUBSCRIPTION_RESOURCE,
  );
  for (const s of ours) {
    try {
      await client.delete(`/subscriptions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      if (!isGraphStatus(err, 404)) throw err;
    }
  }
}

/** Removes the subscription on disconnect. A broken token only clears local state. */
export async function deleteSubscription(userId: string): Promise<void> {
  const [conn] = await service()<{ subscription_id: string | null; status: string }[]>`
    select subscription_id, status from app.calendar_connections where user_id = ${userId}
  `;
  if (conn?.subscription_id && conn.status === "healthy") {
    try {
      await graphClient(userId).delete(`/subscriptions/${encodeURIComponent(conn.subscription_id)}`);
    } catch (err) {
      // 404: already gone. Token problems: Graph expires the subscription on its own.
      if (!isGraphStatus(err, 404) && !(err instanceof CalendarConnectionBroken)) throw err;
    }
  }
  await service()`
    update app.calendar_connections
    set subscription_id = null, subscription_expires_at = null, client_state_hash = null
    where user_id = ${userId}
  `;
}

/** 30-second bucket used to coalesce delta sync jobs per user. */
export function deltaBucket(now = Date.now()): number {
  return Math.floor(now / 30_000);
}

/** 6-hour bucket for subscription ensure jobs enqueued by the cron. */
function ensureBucket(now = Date.now()): number {
  return Math.floor(now / (6 * 3600_000));
}

/**
 * Enqueues graph_subscription_ensure for healthy connections whose subscription expires
 * within 48 hours. Each job renews (or recreates) one subscription with retries.
 */
export async function renewExpiring(db: Db = service()): Promise<number> {
  const rows = await db<{ user_id: string }[]>`
    select user_id from app.calendar_connections
    where status = 'healthy' and subscription_id is not null
      and (subscription_expires_at is null or subscription_expires_at < now() + make_interval(secs => ${RENEW_WITHIN_MS / 1000}))
  `;
  for (const r of rows) {
    await enqueue(db, { kind: "graph_subscription_ensure", payload: { userId: r.user_id }, idempotencyKey: `ensure:${r.user_id}:${ensureBucket()}` });
  }
  return rows.length;
}

/** Enqueues graph_subscription_ensure for healthy connections that have no subscription. */
export async function ensureMissing(db: Db = service()): Promise<number> {
  const rows = await db<{ user_id: string }[]>`
    select user_id from app.calendar_connections where status = 'healthy' and subscription_id is null
  `;
  for (const r of rows) {
    await enqueue(db, { kind: "graph_subscription_ensure", payload: { userId: r.user_id }, idempotencyKey: `ensure:${r.user_id}:${ensureBucket()}` });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Notification verification
// ---------------------------------------------------------------------------

const DUMMY_HASH = sha256Hex("btc-scheduler-no-subscription");

export type VerifiedConnection = { userId: string; subscriptionId: string };

/**
 * Verifies the clientState of each (subscriptionId, clientState) pair. Unknown subscription
 * ids and mismatched states are dropped silently; the comparison runs in constant time and
 * also runs (against a dummy hash) for unknown ids, so callers cannot tell the cases apart.
 */
export async function verifyClientStates(
  items: { subscriptionId: string; clientState: string | null | undefined }[],
): Promise<(VerifiedConnection | null)[]> {
  const ids = [...new Set(items.map((i) => i.subscriptionId))];
  if (ids.length === 0) return [];
  const rows = await service()<{ user_id: string; subscription_id: string; client_state_hash: string | null; status: string }[]>`
    select user_id, subscription_id, client_state_hash, status from app.calendar_connections
    where subscription_id = any(${ids}::text[])
  `;
  const bySub = new Map(rows.map((r) => [r.subscription_id, r]));
  return items.map((item) => {
    const row = bySub.get(item.subscriptionId);
    const expected = row?.client_state_hash ?? DUMMY_HASH;
    const ok = safeEqual(sha256Hex(item.clientState ?? ""), expected);
    return ok && row && row.client_state_hash && row.status === "healthy"
      ? { userId: row.user_id, subscriptionId: item.subscriptionId }
      : null;
  });
}
