import { createHmac } from "node:crypto";

/**
 * Webhook signatures. Each delivery carries
 *   BTC-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed by the secret>
 * Receivers recompute the HMAC over the raw body, compare in constant time and reject
 * timestamps older than a few minutes.
 */

export const SIGNATURE_HEADER = "BTC-Signature";

export function signatureFor(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${signatureFor(secret, timestamp, body)}`;
}
