import "server-only";
import { NextResponse } from "next/server";
import { service } from "@/server/db/client";
import { env } from "@/server/env";
import {
  DEFAULT_TOLERANCE_SECONDS,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from "@/server/crypto/hmac";
import { safeEqual } from "@/server/crypto/random";

/** Maximum accepted request body for sync endpoints. */
export const MAX_SYNC_BODY_BYTES = 2 * 1024 * 1024;

export const NONCE_SOURCE_SNAPSHOT = "sf_queue_snapshot";
export const NONCE_SOURCE_PUSH = "sf_queue_push";

export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

export function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/** Reads the raw body as UTF-8, stopping as soon as it exceeds maxBytes. */
export async function readBodyLimited(req: Request, maxBytes = MAX_SYNC_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type HmacCheck = { ok: true } | { ok: false; response: NextResponse };

/** Verifies X-BTC-Timestamp / X-BTC-Signature against the queue sync signing secret. */
export function checkSyncHmac(req: Request, rawBody: string, nowSeconds?: number): HmacCheck {
  const secret = env().SF_SYNC_SIGNING_SECRET;
  if (!secret) return { ok: false, response: jsonError("not_configured", 503) };
  const result = verifySignature(
    secret,
    rawBody,
    req.headers.get(TIMESTAMP_HEADER),
    req.headers.get(SIGNATURE_HEADER),
    nowSeconds,
  );
  if (!result.ok) return { ok: false, response: jsonError("unauthorized", 401, { reason: result.reason }) };
  return { ok: true };
}

export function hasHmacHeaders(req: Request): boolean {
  return req.headers.has(SIGNATURE_HEADER) || req.headers.has(TIMESTAMP_HEADER);
}

/** Constant-time check of "Authorization: Bearer <SF_QUEUE_PUSH_BEARER>". */
export function checkPushBearer(req: Request): HmacCheck {
  const bearer = env().SF_QUEUE_PUSH_BEARER;
  if (!bearer) return { ok: false, response: jsonError("not_configured", 503) };
  const header = req.headers.get("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${bearer}`)) return { ok: false, response: jsonError("unauthorized", 401) };
  return { ok: true };
}

/** True when an ISO timestamp is within the replay window of now. */
export function isFreshIsoTimestamp(iso: string, nowMs = Date.now(), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Math.abs(nowMs - t) <= toleranceSeconds * 1000;
}

export function nonceHeader(req: Request): string | null {
  const n = req.headers.get(NONCE_HEADER);
  return n && n.length <= 200 ? n : null;
}

/** Records a nonce. Returns false when it was already used (a replay). */
export async function claimNonce(source: string, nonce: string): Promise<boolean> {
  const rows = await service()<{ nonce: string }[]>`
    insert into app.webhook_nonces (source, nonce) values (${source}, ${nonce})
    on conflict do nothing
    returning nonce
  `;
  return rows.length > 0;
}

/** Parses JSON, returning undefined on malformed input. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
