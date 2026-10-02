import "server-only";
import { env } from "@/server/env";
import { RetryAfterError } from "@/server/jobs/types";

/**
 * Minimal typed client for the Slack Web API methods BTC Scheduler uses.
 *
 * - The bot token is sent only in the Authorization header and is never logged or
 *   included in thrown errors.
 * - Write methods (conversations.invite/kick/join, chat.postMessage) send JSON bodies.
 *   Read methods (conversations.info/members, users.lookupByEmail) send form-encoded
 *   bodies, which every Web API method accepts.
 * - HTTP 429, or an `ok: false` response with `error: "ratelimited"`, throws
 *   RetryAfterError with the Retry-After value so the job worker reschedules the job.
 * - Every other Slack error is returned as `{ ok: false, error }` for the caller to map.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SlackResponse<T> = {
  ok: boolean;
  /** Slack error code, or `http_<status>` / `invalid_response` for transport problems. */
  error: string | null;
  /** Seconds from Retry-After when present. */
  retryAfter: number | null;
  data: T | null;
};

export type SlackChannelInfo = {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
  is_general: boolean;
};

export type SlackUser = { id: string; deleted?: boolean; is_bot?: boolean };

export type SlackClient = {
  conversationsInvite(channel: string, user: string): Promise<SlackResponse<Record<string, unknown>>>;
  conversationsKick(channel: string, user: string): Promise<SlackResponse<Record<string, unknown>>>;
  conversationsJoin(channel: string): Promise<SlackResponse<{ channel?: SlackChannelInfo }>>;
  conversationsInfo(channel: string): Promise<SlackResponse<{ channel: SlackChannelInfo }>>;
  conversationsMembers(
    channel: string,
    cursor?: string,
    limit?: number,
  ): Promise<SlackResponse<{ members: string[]; response_metadata?: { next_cursor?: string } }>>;
  usersLookupByEmail(email: string): Promise<SlackResponse<{ user: SlackUser }>>;
  chatPostMessage(channel: string, text: string): Promise<SlackResponse<{ ts?: string }>>;
};

export type SlackClientOptions = {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Used when Slack rate limits without a Retry-After header. */
  defaultRetryAfterSeconds?: number;
};

/** Slack errors that mean the app is not installed or configured correctly. */
export const SLACK_CONFIG_ERRORS = new Set([
  "missing_scope",
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "team_access_not_granted",
  "enterprise_is_restricted",
]);

export class SlackNotConfiguredError extends Error {
  constructor() {
    super("SLACK_BOT_TOKEN is not configured");
    this.name = "SlackNotConfiguredError";
  }
}

function parseRetryAfter(value: string | null, fallback: number): number {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? Math.max(1, n) : fallback;
}

export function createSlackClient(opts: SlackClientOptions): SlackClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = (opts.baseUrl ?? "https://slack.com/api").replace(/\/$/, "");
  const fallbackRetry = opts.defaultRetryAfterSeconds ?? 30;

  async function call<T>(
    method: string,
    args: Record<string, string | number | boolean | undefined>,
    encoding: "json" | "form",
  ): Promise<SlackResponse<T>> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
    let body: string;
    if (encoding === "json") {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(clean);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, String(v)])).toString();
    }

    const res = await doFetch(`${base}/${method}`, { method: "POST", headers, body });
    const retryHeader = res.headers.get("retry-after");
    if (res.status === 429) {
      throw new RetryAfterError(`Slack ${method} rate limited`, parseRetryAfter(retryHeader, fallbackRetry));
    }

    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!json || typeof json.ok !== "boolean") {
      return { ok: false, error: res.ok ? "invalid_response" : `http_${res.status}`, retryAfter: null, data: null };
    }
    if (json.ok === false && json.error === "ratelimited") {
      throw new RetryAfterError(`Slack ${method} rate limited`, parseRetryAfter(retryHeader, fallbackRetry));
    }
    return {
      ok: json.ok,
      error: json.ok ? null : String(json.error ?? "unknown_error"),
      retryAfter: retryHeader === null ? null : parseRetryAfter(retryHeader, fallbackRetry),
      data: json as T,
    };
  }

  return {
    conversationsInvite: (channel, user) => call("conversations.invite", { channel, users: user }, "json"),
    conversationsKick: (channel, user) => call("conversations.kick", { channel, user }, "json"),
    conversationsJoin: (channel) => call("conversations.join", { channel }, "json"),
    conversationsInfo: (channel) => call("conversations.info", { channel }, "form"),
    conversationsMembers: (channel, cursor, limit = 200) =>
      call("conversations.members", { channel, cursor: cursor || undefined, limit }, "form"),
    usersLookupByEmail: (email) => call("users.lookupByEmail", { email }, "form"),
    chatPostMessage: (channel, text) =>
      call("chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false }, "json"),
  };
}

/** Client built from SLACK_BOT_TOKEN. Throws SlackNotConfiguredError when it is unset. */
export function slackClientFromEnv(fetchImpl?: FetchLike): SlackClient {
  const token = env().SLACK_BOT_TOKEN;
  if (!token) throw new SlackNotConfiguredError();
  return createSlackClient({ token, fetch: fetchImpl });
}

/** Lists every member of a conversation, following pagination cursors. */
export async function listAllChannelMembers(
  client: SlackClient,
  channel: string,
): Promise<SlackResponse<{ members: string[] }>> {
  const members: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page++) {
    const res = await client.conversationsMembers(channel, cursor);
    if (!res.ok || !res.data) return { ok: false, error: res.error, retryAfter: res.retryAfter, data: null };
    members.push(...(res.data.members ?? []));
    cursor = res.data.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { ok: true, error: null, retryAfter: null, data: { members } };
}
