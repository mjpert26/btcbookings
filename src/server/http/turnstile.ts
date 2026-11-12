import "server-only";
import { integrationSettings, settingUnavailable } from "@/server/settings/integrations";

export type TurnstileResult = { ok: true } | { ok: false; reason: string };

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Calls Cloudflare's siteverify endpoint. Throws when Cloudflare cannot be reached or does
 * not answer with JSON within five seconds. The secret is sent only in the request body.
 */
export async function siteverify(
  secret: string,
  token: string,
  remoteIp?: string,
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ success: boolean; errorCodes: string[] }> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) });
  const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
  return { success: json.success === true, errorCodes: Array.isArray(json["error-codes"]) ? json["error-codes"].map(String) : [] };
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
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const config = await integrationSettings();
  const secret = config.TURNSTILE_SECRET_KEY;
  if (!secret) return settingUnavailable(config, "TURNSTILE_SECRET_KEY") ? { ok: false, reason: "settings_unavailable" } : { ok: true };
  if (!token || token.length > 2048) return { ok: false, reason: "missing_token" };
  try {
    const result = await siteverify(secret, token, remoteIp, fetchImpl);
    return result.success ? { ok: true } : { ok: false, reason: (result.errorCodes.length ? result.errorCodes : ["failed"]).join(",") };
  } catch {
    return { ok: false, reason: "turnstile_unreachable" };
  }
}
