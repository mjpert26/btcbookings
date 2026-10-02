/** Accepts only same-site relative paths, to prevent open redirects after sign-in. */
export function safeReturnTo(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.length > 500) return fallback;
  return value;
}
