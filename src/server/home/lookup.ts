import "server-only";
import { env } from "@/server/env";
import { integrationSettings } from "@/server/settings/integrations";
import { lookupResponseSchema, type LookupData } from "@/server/home/decide";

/**
 * Client for the n8n workflow "BTC Scheduler - Account Manager Lookup"
 * (n8n/account-manager-lookup.json). The app never calls Salesforce directly.
 *
 * POST {N8N_BASE_URL}{N8N_LOOKUP_WEBHOOK_PATH} with { email } and
 * "Authorization: Bearer <N8N_LOOKUP_TOKEN>". Every failure (no token, timeout, network error,
 * non-2xx status, a body that is not the expected JSON) is reported as a short reason and is
 * treated by the caller as "no match". Reasons never contain the email or the token.
 */

export const LOOKUP_TIMEOUT_MS = 5_000;
/** Largest response body read. A full answer (50 Opportunities, 10 Leads) is far smaller. */
const MAX_BODY_BYTES = 262_144;

export type LookupOutcome = { ok: true; data: LookupData } | { ok: false; reason: string };

export type LookupConfig = { url: string; token: string | undefined };

export type LookupOptions = {
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** For tests: the URL and token, instead of the environment and Admin > Settings. */
  config?: LookupConfig;
};

/** The webhook URL and the token the app uses now. */
export async function lookupConfig(): Promise<LookupConfig> {
  const e = env();
  const settings = await integrationSettings();
  return { url: `${e.N8N_BASE_URL.replace(/\/+$/, "")}${e.N8N_LOOKUP_WEBHOOK_PATH}`, token: settings.N8N_LOOKUP_TOKEN || undefined };
}

/** Lowercased and trimmed, as sent to n8n. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function lookupAccount(email: string, opts: LookupOptions = {}): Promise<LookupOutcome> {
  const config = opts.config ?? (await lookupConfig());
  if (!config.token) return { ok: false, reason: "no_token" };
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ email: normalizeEmail(email) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? LOOKUP_TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `status_${res.status}` };
  }
  let body: unknown;
  try {
    const raw = await res.text();
    if (raw.length > MAX_BODY_BYTES) return { ok: false, reason: "invalid_response" };
    body = JSON.parse(raw);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "invalid_response" };
  }
  const parsed = lookupResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "invalid_response" };
  return { ok: true, data: parsed.data };
}
