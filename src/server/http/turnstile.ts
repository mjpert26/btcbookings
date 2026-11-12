import "server-only";
import { env } from "@/server/env";

export type TurnstileResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies a Cloudflare Turnstile token server-side. Turnstile is optional: when
 * TURNSTILE_SECRET_KEY is not configured, verification is skipped in every environment and
 * the public forms rely on their other protections (same-origin check, per-IP and per-email
 * rate limits, and daily volume caps). Setting the secret turns verification on.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = env().TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true };
  if (!token || token.length > 2048) return { ok: false, reason: "missing_token" };
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return json.success ? { ok: true } : { ok: false, reason: (json["error-codes"] ?? ["failed"]).join(",") };
  } catch {
    return { ok: false, reason: "turnstile_unreachable" };
  }
}
