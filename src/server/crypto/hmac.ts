import "server-only";
import { createHmac } from "node:crypto";
import { safeEqual } from "@/server/crypto/random";

/**
 * HMAC-SHA256 request signing shared by every signed webhook (n8n lead create,
 * queue snapshot, queue push from Apex).
 *
 * Headers:
 *   X-BTC-Timestamp: unix seconds
 *   X-BTC-Signature: sha256=<hex HMAC of "<timestamp>.<raw body>">
 *   X-BTC-Nonce:     optional unique id, recorded for replay protection
 */
export const SIGNATURE_HEADER = "x-btc-signature";
export const TIMESTAMP_HEADER = "x-btc-timestamp";
export const NONCE_HEADER = "x-btc-nonce";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export function signRequest(
  secret: string,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const ts = String(nowSeconds);
  return { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: computeSignature(secret, ts, rawBody) };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "bad_signature" };

export function verifySignature(
  secret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: "stale" };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = computeSignature(secret, timestamp, rawBody);
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "bad_signature" };
}
