import { createHash } from "node:crypto";

/**
 * Pure helpers that prepare an error for the error log: redaction of secrets and personal
 * data, truncation, route normalization and fingerprinting. Nothing here touches the
 * database, so the rules are unit tested directly.
 */

export const ERROR_SOURCES = ["page", "route", "action", "api", "mcp", "job", "cron", "client"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const LIMITS = {
  message: 2000,
  stack: 8000,
  route: 300,
  method: 16,
  errorName: 120,
  digest: 200,
  contextString: 500,
  contextJson: 4000,
  contextKeys: 30,
  contextArray: 20,
  contextDepth: 4,
} as const;

const REDACTED = "[redacted]";

/**
 * Ordered redaction rules. Earlier rules run first so that, for example, a bearer token that
 * is also a JWT is reported as a bearer token.
 */
const TEXT_RULES: [RegExp, string][] = [
  // Cookie headers: everything after the header name on that line.
  [/\b(set-cookie|cookie)(["']?\s*[:=]\s*)[^\r\n]*/gi, `$1$2${REDACTED}`],
  // Authorization header values.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // BTC API keys and OAuth tokens.
  [/\bbtc_(pat|at|rt)_[A-Za-z0-9_-]+/g, `btc_$1_${REDACTED}`],
  // Slack tokens.
  [/\bxox[abprs]-[A-Za-z0-9-]+/g, `xox-${REDACTED}`],
  // JWT-like strings (three base64url segments, the first starting with a JSON header).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[jwt]"],
  // key=value or key: value pairs whose key names a secret.
  [
    /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|code_verifier|signature|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Sensitive URL query parameters, such as an OAuth authorization code.
  [/([?&](?:code|state|token|access_token|key|sig|signature)=)[^&\s#"']+/gi, `$1${REDACTED}`],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  // Phone numbers written with separators, such as +1 (555) 123-4567 or 555.123.4567.
  [/(\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]"],
  // Long digit runs: phone numbers, account and card numbers.
  [/\d{7,}/g, "[number]"],
];

/** Redacts secrets and personal data from free text. */
export function sanitizeText(input: string): string {
  let out = input;
  for (const [re, replacement] of TEXT_RULES) out = out.replace(re, replacement);
  return out;
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 12)) + "…[truncated]";
}

/** Context keys whose values are never stored. */
const SECRET_KEY = /pass|secret|token|authori[sz]ation|cookie|api[_-]?key|signature|session|email|phone|^code$|body|payload|headers?$/i;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(sanitizeText(value), LIMITS.contextString);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[circular]";
  if (depth >= LIMITS.contextDepth) return "[nested]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, LIMITS.contextArray).map((v) => sanitizeValue(v, depth + 1, seen));
    if (value.length > LIMITS.contextArray) items.push(`[${value.length - LIMITS.contextArray} more]`);
    return items;
  }
  const out: Record<string, JsonValue> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, v] of entries.slice(0, LIMITS.contextKeys)) {
    const safeKey = truncate(sanitizeText(key), 80);
    out[safeKey] = SECRET_KEY.test(key) ? REDACTED : sanitizeValue(v, depth + 1, seen);
  }
  if (entries.length > LIMITS.contextKeys) out["_omittedKeys"] = entries.length - LIMITS.contextKeys;
  return out;
}

/**
 * Produces a JSON-safe, size-limited copy of the context with secret-named keys dropped and
 * every string redacted. Returns an empty object for anything that is not a plain object.
 */
export function sanitizeContext(context: unknown): Record<string, JsonValue> {
  if (!context || typeof context !== "object" || Array.isArray(context)) return {};
  const out = sanitizeValue(context, 0, new WeakSet()) as Record<string, JsonValue>;
  const json = JSON.stringify(out);
  if (json.length > LIMITS.contextJson) return { _truncated: true, keys: Object.keys(out).slice(0, LIMITS.contextKeys) };
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Reduces a URL path to a route-like shape: no query string or fragment, and segments that
 * look like identifiers or tokens (UUIDs, numbers, long random strings) replaced with ":id".
 * Manage links carry their token in the path, so this must run before a path is stored.
 */
export function normalizeRoute(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const segments = withoutQuery.split("/").map((segment) => {
    if (segment === "") return segment;
    if (/^\[.*\]$/.test(segment) || /^\(.*\)$/.test(segment)) return segment; // route file patterns
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
    if (/^\d+$/.test(segment)) return ":id";
    if (segment.length >= 20 && /^[A-Za-z0-9_~.%=-]+$/.test(segment) && /\d/.test(segment)) return ":id";
    if (segment.includes("@")) return ":id";
    return truncate(sanitizeText(segment), 80);
  });
  return truncate(segments.join("/") || "/", LIMITS.route);
}

/**
 * The part of a message that identifies the kind of error: identifiers, hex strings and
 * numbers are replaced so that "timeout after 31 ms" and "timeout after 45 ms" group together.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID, "<uuid>")
    // Long opaque identifiers that mix letters and digits, such as Graph or Salesforce ids.
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{15,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function fingerprint(parts: { source: ErrorSource; route: string | null; errorName: string; message: string }): string {
  const key = [parts.source, parts.route ?? "", parts.errorName, normalizeMessage(parts.message)].join("\n");
  return createHash("sha256").update(key).digest("hex");
}

export type ErrorDetails = { name: string; message: string; stack: string | null; digest: string | null; code: string | null };

/** Reads name, message, stack, digest and a database error code from any thrown value. */
export function describeError(err: unknown): ErrorDetails {
  if (err instanceof Error) {
    const e = err as Error & { digest?: unknown; code?: unknown };
    const stack = typeof e.stack === "string" ? e.stack : null;
    return {
      name: e.name || "Error",
      message: e.message || "(no message)",
      // V8 stacks start with "Name: message"; keep only the frames so the message is not stored twice.
      stack: stack ? stack.split("\n").filter((line) => /^\s+at\s/.test(line)).join("\n") || null : null,
      digest: typeof e.digest === "string" ? e.digest : null,
      code: typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : null,
    };
  }
  if (typeof err === "string") return { name: "NonError", message: err || "(empty)", stack: null, digest: null, code: null };
  let message: string;
  try {
    message = JSON.stringify(err) ?? String(err);
  } catch {
    message = String(err);
  }
  const digest = err && typeof err === "object" && "digest" in err && typeof (err as { digest: unknown }).digest === "string" ? (err as { digest: string }).digest : null;
  return { name: "NonError", message, stack: null, digest, code: null };
}

/**
 * Errors Next.js throws on purpose to redirect, render a not-found or forbidden page, or bail
 * out of static rendering. They are control flow, not failures.
 */
export function isFrameworkSignal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest !== "string") return false;
  return /^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING|NEXT_PRERENDER_INTERRUPTED|HANGING_PROMISE_REJECTION)/.test(digest);
}

export type PreparedError = {
  fingerprint: string;
  source: ErrorSource;
  route: string | null;
  method: string | null;
  errorName: string;
  message: string;
  stack: string | null;
  digest: string | null;
  context: Record<string, JsonValue>;
};

/** Builds the row that logError() writes. */
export function prepareError(
  err: unknown,
  opts: { source: ErrorSource; route?: string | null; method?: string | null; context?: Record<string, unknown>; digest?: string | null },
): PreparedError {
  const d = describeError(err);
  const route = opts.route ? normalizeRoute(opts.route) : null;
  const method = opts.method ? truncate(opts.method.toUpperCase().replace(/[^A-Z]/g, ""), LIMITS.method) || null : null;
  const errorName = truncate(sanitizeText(d.name), LIMITS.errorName);
  const message = truncate(sanitizeText(d.message), LIMITS.message);
  const stack = d.stack ? truncate(sanitizeText(d.stack), LIMITS.stack) : null;
  const rawDigest = opts.digest ?? d.digest;
  const digest = rawDigest ? truncate(sanitizeText(rawDigest), LIMITS.digest) : null;
  const context = sanitizeContext({ ...(d.code ? { errorCode: d.code } : {}), ...(opts.context ?? {}) });
  return {
    fingerprint: fingerprint({ source: opts.source, route, errorName, message }),
    source: opts.source,
    route,
    method,
    errorName,
    message,
    stack,
    digest,
    context,
  };
}
