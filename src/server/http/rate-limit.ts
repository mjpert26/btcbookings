import "server-only";
import { service, type Db } from "@/server/db/client";

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/**
 * Fixed-window rate limiter backed by Postgres (app.rate_limits). Suitable for BTC's
 * volume; a Vercel Firewall rule in front of /api/public/* absorbs floods.
 *
 * `key` should combine the route and a hashed client identifier, e.g. `book:<ipHash>`.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  db: Db = service(),
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = new Date((nowSec - (nowSec % windowSeconds)) * 1000);
  const [row] = await db<{ count: number }[]>`
    insert into app.rate_limits (key, window_start, count)
    values (${key}, ${windowStart}, 1)
    on conflict (key, window_start) do update set count = app.rate_limits.count + 1
    returning count
  `;
  const count = Number(row.count);
  const retryAfterSeconds = windowSeconds - (nowSec % windowSeconds);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}

/** Deletes expired windows. Called from the daily maintenance cron. */
export async function purgeRateLimits(db: Db = service()): Promise<void> {
  await db`delete from app.rate_limits where window_start < now() - interval '1 day'`;
}
