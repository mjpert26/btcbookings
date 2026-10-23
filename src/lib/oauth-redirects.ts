/**
 * OAuth redirect (callback) URL rules.
 *
 * A callback URL is acceptable when it is https (or http on a loopback host, RFC 8252),
 * has no fragment and no user info, and matches an allowlisted pattern. A pattern matches a
 * URL exactly, except that ":*" after the host matches any port, so loopback clients that
 * pick a random port can register "http://localhost:*\/callback".
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RedirectCheck = { ok: true; url: string } | { ok: false; reason: string };

export function checkRedirectUri(raw: string): RedirectCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (raw.length > 500) return { ok: false, reason: "too long" };
  if (u.hash || raw.includes("#")) return { ok: false, reason: "must not contain a fragment" };
  if (u.username || u.password) return { ok: false, reason: "must not contain user info" };
  if (u.protocol === "https:") return { ok: true, url: raw };
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return { ok: true, url: raw };
  return { ok: false, reason: "must use https (http is allowed only for localhost)" };
}

/** Validates an allowlist pattern: an https (or loopback http) URL whose port may be "*". */
export function checkRedirectPattern(pattern: string): RedirectCheck {
  const probe = pattern.replace(/:\*(?=\/|$)/, ":1");
  const check = checkRedirectUri(probe);
  if (!check.ok) return check;
  if (pattern.includes("*") && !/:\*(\/|$)/.test(pattern)) return { ok: false, reason: "a wildcard is only allowed as the port (\":*\")" };
  return { ok: true, url: pattern };
}

export function matchesPattern(url: string, pattern: string): boolean {
  if (url === pattern) return true;
  const m = /^(https?:\/\/[^/:]+):\*(\/.*)?$/.exec(pattern);
  if (!m) return false;
  const [, origin, rest = ""] = m;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!u.port) return false;
  return `${u.protocol}//${u.hostname}` === origin && `${u.pathname}${u.search}` === (rest || "/");
}

export function isAllowedRedirect(url: string, patterns: string[]): boolean {
  return checkRedirectUri(url).ok && patterns.some((p) => matchesPattern(url, p));
}
