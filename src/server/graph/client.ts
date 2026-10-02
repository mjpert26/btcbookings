import "server-only";
import { service } from "@/server/db/client";
import { getGraphAccessToken } from "@/server/graph/tokens";
import { BOOKING_PROPERTY_ID } from "@/server/graph/event-payload";

/**
 * Minimal typed Microsoft Graph REST client.
 *
 * - One client per user: requests use that user's delegated token (getGraphAccessToken).
 * - 429, 503 and 504 are retried a bounded number of times, honoring Retry-After. A wait
 *   longer than maxInlineWaitSeconds is not slept in-process; a GraphThrottledError carrying
 *   retryAfterSeconds is thrown instead so the job worker can reschedule.
 * - A 401 triggers exactly one forced token refresh and one retry.
 * - Tokens are never logged or included in error messages.
 */
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_ORIGIN = "https://graph.microsoft.com";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type TokenProvider = (userId: string, opts: { forceRefresh: boolean }) => Promise<string>;

export type GraphConfig = {
  fetch: FetchLike;
  tokenProvider: TokenProvider;
  sleep: (ms: number) => Promise<void>;
  /** Retries for 429/503/504 and network errors. */
  maxRetries: number;
  /** Longest Retry-After honored by sleeping in-process. */
  maxInlineWaitSeconds: number;
  /** Default per-request timeout. */
  timeoutMs: number;
};

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** Still throttled (or unavailable) after the bounded retries. */
export class GraphThrottledError extends GraphError {
  constructor(status: number, code: string | null, readonly retryAfterSeconds: number, requestId: string | null) {
    super(`Microsoft Graph throttled the request (HTTP ${status})`, status, code, requestId);
    this.name = "GraphThrottledError";
  }
}

/** The request did not complete within its timeout or failed at the network level. */
export class GraphNetworkError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = "GraphNetworkError";
  }
}

export function isGraphStatus(err: unknown, ...statuses: number[]): err is GraphError {
  return err instanceof GraphError && statuses.includes(err.status);
}

/** Forces the next getGraphAccessToken call to refresh by expiring the cached access token. */
export async function forceTokenRefresh(userId: string): Promise<string> {
  await service()`
    update app.calendar_connections set token_expires_at = now() - interval '1 second'
    where user_id = ${userId} and status = 'healthy'
  `;
  return getGraphAccessToken(userId);
}

const defaultConfig = (): GraphConfig => ({
  fetch: (input, init) => fetch(input, init),
  tokenProvider: (userId, { forceRefresh }) => (forceRefresh ? forceTokenRefresh(userId) : getGraphAccessToken(userId)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries: 3,
  maxInlineWaitSeconds: 20,
  timeoutMs: 15_000,
});

let override: Partial<GraphConfig> | null = null;

/** For tests: replace the fetch implementation, token provider or sleep. Pass null to reset. */
export function configureGraph(cfg: Partial<GraphConfig> | null): void {
  override = cfg;
}

function config(): GraphConfig {
  return { ...defaultConfig(), ...(override ?? {}) };
}

export type GraphRequest = {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Overrides config.maxRetries (e.g. 0 for latency-sensitive calls). */
  maxRetries?: number;
};

export type GraphResponse<T> = { status: number; data: T; headers: Headers };

/** Parses Retry-After (delta seconds or HTTP date). Returns null when absent or invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function resolveUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    // Only ever send the bearer token to Graph (delta and next links are absolute URLs).
    const u = new URL(pathOrUrl);
    if (u.origin !== GRAPH_ORIGIN) throw new Error("Refusing to call a non-Graph URL with a Graph token");
    return u.toString();
  }
  return GRAPH_BASE + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
}

async function readError(res: Response): Promise<{ code: string | null; message: string | null }> {
  try {
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    return { code: json.error?.code ?? null, message: json.error?.message ?? null };
  } catch {
    return { code: null, message: null };
  }
}

const RETRYABLE = new Set([429, 503, 504]);

export class GraphClient {
  constructor(readonly userId: string) {}

  async request<T = unknown>(method: string, pathOrUrl: string, req: GraphRequest = {}): Promise<GraphResponse<T>> {
    const cfg = config();
    const url = resolveUrl(pathOrUrl);
    const maxRetries = req.maxRetries ?? cfg.maxRetries;
    let token = await cfg.tokenProvider(this.userId, { forceRefresh: false });
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      const headers: Record<string, string> = { accept: "application/json", ...req.headers, authorization: `Bearer ${token}` };
      let body: string | undefined;
      if (req.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(req.body);
      }

      let res: Response;
      try {
        res = await cfg.fetch(url, { method, headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? cfg.timeoutMs) });
      } catch (err) {
        const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        if (attempt < maxRetries && !timedOut) {
          attempt++;
          await cfg.sleep(backoffMs(attempt));
          continue;
        }
        throw new GraphNetworkError(timedOut ? "Microsoft Graph request timed out" : "Microsoft Graph request failed", timedOut);
      }

      const requestId = res.headers.get("request-id");

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        void res.body?.cancel().catch(() => {});
        token = await cfg.tokenProvider(this.userId, { forceRefresh: true });
        continue;
      }

      if (RETRYABLE.has(res.status)) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const { code } = await readError(res);
        const waitSeconds = retryAfter ?? backoffMs(attempt + 1) / 1000;
        if (attempt < maxRetries && waitSeconds <= cfg.maxInlineWaitSeconds) {
          attempt++;
          await cfg.sleep(Math.round(waitSeconds * 1000));
          continue;
        }
        throw new GraphThrottledError(res.status, code, Math.max(1, Math.ceil(waitSeconds)), requestId);
      }

      if (!res.ok) {
        const { code, message } = await readError(res);
        const detail = message ? `: ${message.slice(0, 300)}` : "";
        throw new GraphError(`Microsoft Graph ${method} failed with HTTP ${res.status}${code ? ` (${code})` : ""}${detail}`, res.status, code, requestId);
      }

      if (res.status === 204 || res.status === 202) {
        void res.body?.cancel().catch(() => {});
        return { status: res.status, data: null as T, headers: res.headers };
      }
      const text = await res.text();
      return { status: res.status, data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
    }
  }

  get<T>(path: string, req?: GraphRequest) {
    return this.request<T>("GET", path, req);
  }
  post<T>(path: string, body: unknown, req?: GraphRequest) {
    return this.request<T>("POST", path, { ...req, body });
  }
  patch<T>(path: string, body: unknown, req?: GraphRequest) {
    return this.request<T>("PATCH", path, { ...req, body });
  }
  delete(path: string, req?: GraphRequest) {
    return this.request<null>("DELETE", path, req);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

/**
 * Builds a query string with spaces encoded as %20 (not "+"), as Graph expects inside
 * OData expressions such as $filter.
 */
export function graphQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%24/g, "$")}=${encodeURIComponent(v)}`)
    .join("&");
}

export function graphClient(userId: string): GraphClient {
  return new GraphClient(userId);
}

// ---------------------------------------------------------------------------
// Shared Graph shapes and helpers
// ---------------------------------------------------------------------------

/** Extended property used to tag the app's own Outlook events with the booking id. */
export const BOOKING_PROP_ID = BOOKING_PROPERTY_ID;

export type DateTimeTimeZone = { dateTime: string; timeZone: string };

export type GraphEvent = {
  id: string;
  iCalUId?: string | null;
  start?: DateTimeTimeZone | null;
  end?: DateTimeTimeZone | null;
  showAs?: string | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  transactionId?: string | null;
  type?: string | null;
  singleValueExtendedProperties?: { id: string; value: string }[];
  onlineMeeting?: { joinUrl?: string | null } | null;
  "@removed"?: { reason?: string };
};

export type GraphPage<T> = { value: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

/** "$filter" expression that matches events tagged with the given booking id. */
export function bookingFilter(bookingId: string): string {
  return `singleValueExtendedProperties/Any(ep: ep/id eq '${BOOKING_PROP_ID}' and ep/value eq '${bookingId.replace(/'/g, "''")}')`;
}

export const EXPAND_BOOKING_PROP = `singleValueExtendedProperties($filter=id eq '${BOOKING_PROP_ID}')`;
