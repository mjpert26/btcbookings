import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import { z } from "zod";
import { service, type Sql, type Tx } from "@/server/db/client";
import { decryptSecret } from "@/server/crypto/aes";
import { enqueue } from "@/server/jobs/queue";
import { PermanentJobError, RetryAfterError, type JobContext, type JobHandler, type JobResult, type JobRow } from "@/server/jobs/types";
import { buildBookingEventBody, isWebhookEvent, type WebhookEvent } from "@/server/webhooks/payload";
import { signatureHeader, SIGNATURE_HEADER } from "@/server/webhooks/sign";
import { resolvePublicUrl, type LookupFn } from "@/server/webhooks/url";

/**
 * webhook_dispatch: one per booking event (enqueued by the bookings triggers). Records a
 * delivery for every enabled endpoint subscribed to the event (and to the booking's team,
 * when the endpoint is limited to one) and enqueues its webhook_deliver job.
 *
 * webhook_deliver: POSTs one delivery, signed with the endpoint's secret. 2xx succeeds;
 * 4xx other than 408, 409, 425 and 429 fails without retrying; anything else is retried
 * with the outbox backoff.
 */

const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVER_MAX_ATTEMPTS = 8;
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);

const dispatchSchema = z.object({
  bookingId: z.uuid(),
  event: z.string().refine(isWebhookEvent),
  eventId: z.uuid(),
  occurredAt: z.string(),
});
const deliverSchema = z.object({ deliveryId: z.uuid() });

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type WebhookDeps = { sql?: Sql; fetch?: FetchLike; lookup?: LookupFn; now?: () => number };

const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function handleWebhookDispatch(job: Pick<JobRow, "payload">, deps: WebhookDeps = {}): Promise<JobResult> {
  const parsed = dispatchSchema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError("Invalid webhook_dispatch payload");
  const p = { ...parsed.data, event: parsed.data.event as WebhookEvent };
  const sql = deps.sql ?? service();
  const endpoints = await sql<{ id: string }[]>`
    select e.id from app.webhook_endpoints e
    where e.enabled and ${p.event} = any (e.events)
      and (e.team_id is null or e.team_id = (
        select et.team_id from app.bookings b join app.event_types et on et.id = b.event_type_id where b.id = ${p.bookingId}
      ))
  `;
  if (!endpoints.length) return { result: { skipped: "no_endpoints" } };
  const body = await buildBookingEventBody(sql, p);
  if (!body) return { result: { skipped: "booking_not_found" } };
  const created = await sql.begin(async (tx: Tx) => {
    let n = 0;
    for (const e of endpoints) {
      const [row] = await tx<{ id: string }[]>`
        insert into app.webhook_deliveries (endpoint_id, event_id, event, booking_id, payload)
        values (${e.id}, ${p.eventId}, ${p.event}, ${p.bookingId}, ${tx.json(body as never)})
        on conflict (endpoint_id, event_id) do nothing
        returning id
      `;
      if (!row) continue;
      await enqueue(tx, {
        kind: "webhook_deliver",
        payload: { deliveryId: row.id, bookingId: p.bookingId },
        idempotencyKey: row.id,
        bookingId: p.bookingId,
        maxAttempts: DELIVER_MAX_ATTEMPTS,
      });
      n++;
    }
    return n;
  });
  return { result: { deliveries: created } };
}

type DeliveryRow = {
  id: string;
  event: string;
  payload: Record<string, unknown>;
  status: string;
  endpoint_id: string;
  url: string;
  secret_enc: string;
  enabled: boolean;
};

async function recordAttempt(
  sql: Sql,
  d: DeliveryRow,
  outcome: { status: "pending" | "succeeded" | "failed"; code: number | null; error: string | null },
): Promise<void> {
  const ok = outcome.status === "succeeded";
  await sql`
    update app.webhook_deliveries set
      attempts = attempts + 1, status = ${outcome.status}, response_status = ${outcome.code},
      error = ${outcome.error ? outcome.error.slice(0, 500) : null},
      delivered_at = ${ok ? sql`now()` : sql`delivered_at`}
    where id = ${d.id}
  `;
  await sql`
    update app.webhook_endpoints set
      last_delivery_at = now(), last_status = ${outcome.code},
      consecutive_failures = ${ok ? 0 : sql`consecutive_failures + 1`}
    where id = ${d.endpoint_id}
  `;
}

export async function handleWebhookDeliver(
  job: Pick<JobRow, "payload" | "attempts" | "max_attempts">,
  ctx: Pick<JobContext, "log">,
  deps: WebhookDeps = {},
): Promise<JobResult> {
  const parsed = deliverSchema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError("Invalid webhook_deliver payload");
  const sql = deps.sql ?? service();
  const [d] = await sql<DeliveryRow[]>`
    select d.id, d.event, d.payload, d.status, d.endpoint_id, e.url, e.secret_enc, e.enabled
    from app.webhook_deliveries d join app.webhook_endpoints e on e.id = d.endpoint_id
    where d.id = ${parsed.data.deliveryId}
  `;
  if (!d) return { result: { skipped: "delivery_not_found" } };
  if (d.status === "succeeded") return { result: { skipped: "already_delivered" } };
  if (!d.enabled) {
    await sql`update app.webhook_deliveries set status = 'failed', error = 'Endpoint disabled' where id = ${d.id}`;
    return { result: { skipped: "endpoint_disabled" } };
  }

  const target = await resolvePublicUrl(d.url, deps.lookup ?? defaultLookup);
  if (!target.ok) {
    await recordAttempt(sql, d, { status: "failed", code: null, error: `URL ${target.reason}` });
    throw new PermanentJobError(`Webhook URL ${target.reason}`);
  }

  const body = JSON.stringify(d.payload);
  const timestamp = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const secret = decryptSecret(d.secret_enc, d.endpoint_id);
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  // The worker counts the current attempt before calling the handler.
  const isLastAttempt = job.attempts >= job.max_attempts;
  const request = { host: target.url.host, event: d.event, deliveryId: d.id };
  ctx.log({ request });

  let res: Response;
  try {
    res = await doFetch(target.url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "BTC-Scheduler-Webhooks/1.0",
        "BTC-Webhook-Id": d.id,
        "BTC-Webhook-Event": d.event,
        [SIGNATURE_HEADER]: signatureHeader(secret, timestamp, body),
      },
      body,
    });
  } catch (err) {
    const message = err instanceof Error && err.name === "TimeoutError" ? "Timed out after 10 seconds" : "Connection failed";
    await recordAttempt(sql, d, { status: isLastAttempt ? "failed" : "pending", code: null, error: message });
    throw new Error(`Webhook delivery failed: ${message}`);
  }
  // The response body is not used; cancel it to release the connection.
  await res.body?.cancel().catch(() => undefined);
  ctx.log({ request, responseCode: res.status });

  if (res.status >= 200 && res.status < 300) {
    await recordAttempt(sql, d, { status: "succeeded", code: res.status, error: null });
    return { result: { status: res.status } };
  }
  const permanent = res.status >= 400 && res.status < 500 && !RETRYABLE_4XX.has(res.status);
  await recordAttempt(sql, d, { status: permanent || isLastAttempt ? "failed" : "pending", code: res.status, error: `HTTP ${res.status}` });
  if (permanent) throw new PermanentJobError(`Webhook endpoint answered ${res.status}`);
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
    throw new RetryAfterError("Webhook endpoint rate limited", Math.min(retryAfter, 3600));
  }
  throw new Error(`Webhook endpoint answered ${res.status}`);
}

export function createWebhookHandlers(deps: WebhookDeps = {}): Record<string, JobHandler> {
  return {
    webhook_dispatch: (job) => handleWebhookDispatch(job, deps),
    webhook_deliver: (job, ctx) => handleWebhookDeliver(job, ctx, deps),
  };
}

export const webhookHandlers: Record<string, JobHandler> = createWebhookHandlers();
