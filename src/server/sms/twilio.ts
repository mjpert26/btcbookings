import "server-only";
import { createHmac } from "node:crypto";
import { PermanentJobError, RetryAfterError } from "@/server/jobs/types";
import { safeEqual, sha256Hex } from "@/server/crypto/random";
import type { FetchLike, SmsMessage, SmsSendResult } from "@/server/sms/sendblue";

/**
 * Minimal Twilio Programmable Messaging client for one-to-one text messages.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Authorization: Basic base64(AccountSid:AuthToken)
 *   Body (form-encoded): To, From, Body
 *
 * The auth token is sent only in the Authorization header and is never logged or included
 * in errors.
 *
 * Error mapping for the job worker:
 * - HTTP 429, or error code 20429 (too many requests), retries later.
 * - 5xx responses, transport failures and timeouts (TWILIO_TIMEOUT_MS) are retried with the
 *   worker's backoff.
 * - Other 4xx responses are permanent, for example 21211 (invalid number), 21610 (the
 *   recipient replied STOP to this number) or 20003 (wrong credentials).
 * - A created message whose status is already "failed" or "undelivered" is permanent.
 */

export const TWILIO_TIMEOUT_MS = 15_000;

export type TwilioOptions = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Request timeout. Defaults to TWILIO_TIMEOUT_MS. */
  timeoutMs?: number;
};

export type TwilioClient = { sendMessage(msg: SmsMessage): Promise<SmsSendResult> };

const RATE_RETRY_SECONDS = 60;

function retryAfter(res: Response, fallback: number): number {
  const n = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function errorCode(json: Record<string, unknown> | null): string | null {
  const c = json?.code ?? json?.error_code;
  return c === undefined || c === null || c === 0 || c === "0" ? null : String(c);
}

function errorSummary(json: Record<string, unknown> | null, status: number): string {
  const c = errorCode(json);
  return ["Twilio", `http_${status}`, c ? `code_${c}` : null].filter(Boolean).join(" ");
}

export function createTwilioClient(opts: TwilioOptions): TwilioClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = (opts.baseUrl ?? "https://api.twilio.com").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? TWILIO_TIMEOUT_MS;
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;

  return {
    async sendMessage(msg) {
      let res: Response;
      try {
        res = await doFetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: msg.to, From: opts.fromNumber, Body: msg.content }).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        // Retryable: the worker's backoff applies. The message never includes the token.
        throw new Error(name === "TimeoutError" || name === "AbortError" ? "Twilio request timed out" : "Twilio request failed");
      }
      let json: Record<string, unknown> | null = null;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = null;
      }
      if (res.status === 429 || errorCode(json) === "20429") {
        throw new RetryAfterError(errorSummary(json, res.status), retryAfter(res, RATE_RETRY_SECONDS));
      }
      if (res.status >= 500) throw new Error(errorSummary(json, res.status));
      if (res.status >= 400) throw new PermanentJobError(errorSummary(json, res.status));
      const status = typeof json?.status === "string" ? json.status : null;
      if (status === "failed" || status === "undelivered") throw new PermanentJobError(errorSummary(json, res.status));
      const sid = typeof json?.sid === "string" ? json.sid : null;
      return { messageHandle: sid, status, skipped: false };
    },
  };
}

/**
 * The X-Twilio-Signature of a form-encoded webhook request: Base64 of HMAC-SHA1, keyed with
 * the account's auth token, over the full request URL followed by every POST parameter as
 * name + value, sorted by name (values of a repeated name are sorted too).
 * See https://www.twilio.com/docs/usage/security#validating-requests.
 */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const names = [...new Set(params.keys())].sort();
  let data = url;
  for (const name of names) {
    for (const value of params.getAll(name).sort()) data += name + value;
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * True when `signature` matches the signature of one of the candidate URLs. Twilio signs the
 * URL configured on the number, so the caller passes the URL as received and as rebuilt from
 * APP_BASE_URL. Compared in constant time.
 */
export function validTwilioSignature(authToken: string, signature: string | null, urls: readonly string[], params: URLSearchParams): boolean {
  if (!signature) return false;
  const received = sha256Hex(signature);
  let ok = false;
  for (const url of new Set(urls)) {
    if (safeEqual(received, sha256Hex(twilioSignature(authToken, url, params)))) ok = true;
  }
  return ok;
}
