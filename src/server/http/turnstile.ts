import "server-only";
import { env } from "@/server/env";
import { integrationSettings, settingUnavailable } from "@/server/settings/integrations";

export type TurnstileResult = { ok: true } | { ok: false; reason: string };

/** The action each protected public form sends with its widget (data-action), checked here. */
export const TURNSTILE_ACTIONS = ["book", "reschedule", "cancel"] as const;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[number];

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * Frontend hostnames whose tokens are accepted: TURNSTILE_HOSTNAMES, else the hostname of
 * APP_BASE_URL. localhost and 127.0.0.1 are never accepted in production.
 */
export function turnstileHostnames(): Set<string> {
  const e = env();
  const listed = (e.TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const hosts = listed.length ? listed : [new URL(e.APP_BASE_URL).hostname.toLowerCase()];
  return new Set(e.NODE_ENV === "production" ? hosts.filter((h) => !LOCAL_HOSTNAMES.has(h)) : hosts);
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type SiteverifyResult = { success: boolean; errorCodes: string[]; action: string | null; hostname: string | null };

/**
 * Calls Cloudflare's siteverify endpoint. Throws when Cloudflare cannot be reached, answers
 * with a non-2xx status, or does not answer with JSON within ten seconds. The secret is sent
 * only in the request body.
 */
export async function siteverify(
  secret: string,
  token: string,
  remoteIp?: string,
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<SiteverifyResult> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`siteverify ${res.status}`);
  const json = (await res.json()) as { success?: boolean; "error-codes"?: unknown; action?: unknown; hostname?: unknown };
  return {
    success: json.success === true,
    errorCodes: Array.isArray(json["error-codes"]) ? json["error-codes"].map(String) : [],
    action: typeof json.action === "string" ? json.action : null,
    hostname: typeof json.hostname === "string" ? json.hostname.toLowerCase() : null,
  };
}

/**
 * Verifies a Cloudflare Turnstile token server-side. Turnstile is optional: when the
 * TURNSTILE_SECRET_KEY setting (Admin > Settings, else Vercel) is not set, verification is
 * skipped in every environment and the public forms rely on their other protections
 * (same-origin check, per-IP and per-email rate limits, and daily volume caps). Setting the
 * secret turns verification on.
 *
 * When the secret may be set in Admin > Settings but could not be read (the settings table
 * was unreadable on this instance, or the stored secret does not decrypt) and Vercel has no
 * secret, verification fails closed with `settings_unavailable`, as it does when Cloudflare
 * cannot be reached.
 *
 * A token passes only when Cloudflare reports success, the token's action equals the form's
 * action, and the token was issued on an accepted hostname (turnstileHostnames()). Tokens are
 * single-use: Cloudflare answers a replayed token with timeout-or-duplicate.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  opts: { action: TurnstileAction; remoteIp?: string; fetchImpl?: typeof fetch },
): Promise<TurnstileResult> {
  const config = await integrationSettings();
  const secret = config.TURNSTILE_SECRET_KEY;
  if (!secret) return settingUnavailable(config, "TURNSTILE_SECRET_KEY") ? { ok: false, reason: "settings_unavailable" } : { ok: true };
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return { ok: false, reason: "missing_token" };
  const hostnames = turnstileHostnames();
  if (hostnames.size === 0) return { ok: false, reason: "no_hostnames" };
  let result: SiteverifyResult;
  try {
    result = await siteverify(secret, token, opts.remoteIp, opts.fetchImpl ?? fetch);
  } catch {
    return { ok: false, reason: "turnstile_unreachable" };
  }
  if (!result.success) return { ok: false, reason: (result.errorCodes.length ? result.errorCodes : ["failed"]).join(",") };
  if (result.action !== opts.action) return { ok: false, reason: "action_mismatch" };
  if (!result.hostname || !hostnames.has(result.hostname)) return { ok: false, reason: "hostname_mismatch" };
  return { ok: true };
}
