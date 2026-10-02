const BASE = "http://btc.invalid";

/**
 * Accepts only same-origin relative paths, to prevent open redirects after sign-in.
 * Control characters and backslashes are rejected outright because browsers strip or
 * reinterpret them (e.g. "/\t/evil.example" becomes "//evil.example").
 */
export function safeReturnTo(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value || value.length > 500) return fallback;
  if (/[\x00-\x1f\x7f\\]/.test(value)) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (parsed.origin !== BASE) return fallback;
  return parsed.pathname + parsed.search + parsed.hash;
}
