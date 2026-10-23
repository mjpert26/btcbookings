import "server-only";
import { env } from "@/server/env";
import { PermanentJobError, RetryAfterError } from "@/server/jobs/types";
import { redactPhone } from "@/server/sms/phone";

/**
 * Minimal SendBlue client for one-to-one text messages.
 *
 *   POST https://api.sendblue.com/api/send-message
 *   Headers: sb-api-key-id, sb-api-secret-key, Content-Type: application/json
 *   Body:    { number, content, from_number? }
 *
 * The API key and secret are sent only in headers and never logged or included in errors.
 *
 * Error mapping for the job worker:
 * - HTTP 429, or a send-time capacity decline (HTTP 400 with error_code 429), retries later.
 * - Rate-limit error codes in the body (4001, 5003, 5509, SMS_LIMIT_REACHED) retry later.
 * - Other 4xx responses and ERROR / DECLINED statuses are permanent (bad number, blacklisted).
 * - 5xx responses, transport failures and timeouts (SENDBLUE_TIMEOUT_MS) are retried with
 *   the worker's backoff.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SendblueOptions = {
  apiKey: string;
  apiSecret: string;
  fromNumber?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Request timeout. Defaults to SENDBLUE_TIMEOUT_MS. */
  timeoutMs?: number;
};

/**
 * Each send is aborted after this long, well inside the 60 second function limit, so a
 * stalled request fails and retries with backoff instead of the function being killed
 * while the job is running.
 */
export const SENDBLUE_TIMEOUT_MS = 15_000;

export type SmsMessage = { to: string; content: string };

export type SmsSendResult = { messageHandle: string | null; status: string | null; skipped: boolean };

export type SendblueClient = { sendMessage(msg: SmsMessage): Promise<SmsSendResult> };

const RATE_LIMIT_CODES = new Set(["4001", "5003", "5509", "SMS_LIMIT_REACHED"]);
const CAPACITY_RETRY_SECONDS = 3600;
const RATE_RETRY_SECONDS = 60;

function retryAfter(res: Response, fallback: number): number {
  const n = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function code(json: Record<string, unknown> | null): string | null {
  const c = json?.error_code;
  return c === undefined || c === null || c === 0 || c === "0" ? null : String(c);
}

function errorSummary(json: Record<string, unknown> | null, status: number): string {
  const key = typeof json?.error_key === "string" ? json.error_key : null;
  const c = code(json);
  return ["SendBlue", `http_${status}`, c ? `code_${c}` : null, key].filter(Boolean).join(" ").slice(0, 300);
}

export function createSendblueClient(opts: SendblueOptions): SendblueClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = (opts.baseUrl ?? "https://api.sendblue.com").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? SENDBLUE_TIMEOUT_MS;

  return {
    async sendMessage(msg) {
      const body: Record<string, string> = { number: msg.to, content: msg.content };
      if (opts.fromNumber) body.from_number = opts.fromNumber;
      let res: Response;
      try {
        res = await doFetch(`${base}/api/send-message`, {
          method: "POST",
          headers: {
            "sb-api-key-id": opts.apiKey,
            "sb-api-secret-key": opts.apiSecret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        // Retryable: the worker's backoff applies. The message never includes the key or secret.
        throw new Error(name === "TimeoutError" || name === "AbortError" ? "SendBlue request timed out" : "SendBlue request failed");
      }
      let json: Record<string, unknown> | null = null;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = null;
      }
      const errCode = code(json);
      if (res.status === 429) throw new RetryAfterError("SendBlue rate limited", retryAfter(res, RATE_RETRY_SECONDS));
      if (res.status === 400 && errCode === "429") {
        throw new RetryAfterError(errorSummary(json, res.status), CAPACITY_RETRY_SECONDS);
      }
      if (errCode && RATE_LIMIT_CODES.has(errCode)) {
        throw new RetryAfterError(errorSummary(json, res.status), retryAfter(res, RATE_RETRY_SECONDS));
      }
      if (res.status >= 500) throw new Error(errorSummary(json, res.status));
      if (res.status >= 400) throw new PermanentJobError(errorSummary(json, res.status));
      const status = typeof json?.status === "string" ? json.status : null;
      if (status === "ERROR" || status === "DECLINED" || errCode) {
        throw new PermanentJobError(errorSummary(json, res.status));
      }
      const handle = typeof json?.message_handle === "string" ? json.message_handle : null;
      return { messageHandle: handle, status, skipped: false };
    },
  };
}

export type SmsTransport = (msg: SmsMessage) => Promise<SmsSendResult>;

let override: SmsTransport | null = null;

/** For tests: capture outgoing texts instead of calling SendBlue. Pass null to restore. */
export function setSmsTransport(transport: SmsTransport | null): void {
  override = transport;
}

/**
 * Sends one text. Without SENDBLUE_API_KEY and SENDBLUE_API_SECRET it logs a redacted line
 * and reports a skipped send, so jobs complete normally.
 */
export async function sendSms(msg: SmsMessage, tag: string): Promise<SmsSendResult> {
  if (override) return override(msg);
  const e = env();
  if (!e.SENDBLUE_API_KEY || !e.SENDBLUE_API_SECRET) {
    console.info(`[sms] SENDBLUE_API_KEY not set; not sent: ${tag} to ${redactPhone(msg.to)}`);
    return { messageHandle: null, status: null, skipped: true };
  }
  const client = createSendblueClient({
    apiKey: e.SENDBLUE_API_KEY,
    apiSecret: e.SENDBLUE_API_SECRET,
    fromNumber: e.SENDBLUE_FROM_NUMBER,
  });
  return client.sendMessage(msg);
}
