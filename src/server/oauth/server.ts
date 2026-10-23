import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { service, type Db } from "@/server/db/client";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import { isAllowedRedirect } from "@/lib/oauth-redirects";
import {
  acceptedResources,
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  MCP_SCOPE,
  mcpResource,
  REFRESH_TOKEN_TTL_DAYS,
} from "@/server/oauth/config";

/**
 * OAuth 2.1 authorization server for MCP clients, plus API keys.
 *
 * - Public clients only (token_endpoint_auth_method "none"), PKCE S256 required.
 * - Dynamic client registration (RFC 7591) accepts only callback URLs on the admin allowlist.
 * - Tokens are opaque random strings; only SHA-256 hashes are stored. Access tokens live one
 *   hour; refresh tokens rotate on every use, and presenting a used refresh token revokes the
 *   whole token family (reuse detection).
 * - Every token acts as its user with the user's current role, so a role change or
 *   deactivation applies immediately.
 */

export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" | "invalid_redirect_uri" | "invalid_client_metadata" | "invalid_target",
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

export type TokenKind = "api_key" | "oauth_access" | "oauth_refresh";
const PREFIX: Record<TokenKind, string> = { api_key: "btc_pat_", oauth_access: "btc_at_", oauth_refresh: "btc_rt_" };

function newToken(kind: TokenKind): { token: string; hash: string; prefix: string } {
  const token = `${PREFIX[kind]}${randomToken(32)}`;
  return { token, hash: sha256Hex(token), prefix: token.slice(0, PREFIX[kind].length + 6) };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export type OAuthClient = { client_id: string; name: string; redirect_uris: string[]; registered_via: "dynamic" | "admin" };

export async function allowedRedirectPatterns(db: Db = service()): Promise<string[]> {
  const rows = await db<{ pattern: string }[]>`select pattern from app.oauth_redirect_allowlist`;
  return rows.map((r) => r.pattern);
}

/** RFC 7591 dynamic registration. Every redirect URI must be on the allowlist. */
export async function registerClient(
  input: { client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown },
  opts: { via?: "dynamic" | "admin"; createdBy?: string | null; db?: Db } = {},
): Promise<OAuthClient> {
  const db = opts.db ?? service();
  const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 100) : "MCP client";
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "Provide between 1 and 10 redirect_uris.");
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method \"none\") are supported.");
  }
  if (Array.isArray(input.grant_types) && input.grant_types.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new OAuthError("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
  }
  const patterns = await allowedRedirectPatterns(db);
  const rejected = uris.filter((u) => !isAllowedRedirect(u, patterns));
  if (rejected.length) {
    throw new OAuthError("invalid_redirect_uri", `Callback URL not allowed: ${rejected[0].slice(0, 200)}. An admin can allow it in BTC Scheduler under Admin > Integrations.`);
  }
  const clientId = `btc_${randomToken(18)}`;
  await db`
    insert into app.oauth_clients (client_id, name, redirect_uris, registered_via, created_by)
    values (${clientId}, ${name}, ${uris}, ${opts.via ?? "dynamic"}, ${opts.createdBy ?? null})
  `;
  return { client_id: clientId, name, redirect_uris: uris, registered_via: opts.via ?? "dynamic" };
}

export async function getClient(clientId: string, db: Db = service()): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 100) return null;
  const [row] = await db<OAuthClient[]>`
    select client_id, name, redirect_uris, registered_via from app.oauth_clients
    where client_id = ${clientId} and disabled_at is null
  `;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Authorization requests and codes
// ---------------------------------------------------------------------------

export type AuthorizeRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string;
};

/**
 * Validates /oauth/authorize parameters. Errors that make the redirect URI untrustworthy are
 * thrown (shown on our own page); everything else is returned for redirecting to the client.
 */
export async function validateAuthorizeRequest(params: URLSearchParams, db: Db = service()): Promise<AuthorizeRequest> {
  const client = await getClient(params.get("client_id") ?? "", db);
  if (!client) throw new OAuthError("invalid_client", "Unknown or disabled client.");
  const redirectUri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!client.redirect_uris.includes(redirectUri)) throw new OAuthError("invalid_redirect_uri", "The callback URL is not registered for this client.");
  const patterns = await allowedRedirectPatterns(db);
  if (!isAllowedRedirect(redirectUri, patterns)) throw new OAuthError("invalid_redirect_uri", "The callback URL is no longer allowed.");
  if (params.get("response_type") !== "code") throw new OAuthError("invalid_request", "response_type must be \"code\".");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new OAuthError("invalid_request", "PKCE with code_challenge_method S256 is required.");
  }
  const scope = normalizeScope(params.get("scope"));
  const resource = normalizeResource(params.get("resource"));
  return { client, redirectUri, state: params.get("state"), codeChallenge, scope, resource };
}

function normalizeScope(raw: string | null): string {
  const requested = (raw ?? "").split(/\s+/).filter(Boolean);
  const unknown = requested.filter((s) => s !== MCP_SCOPE && s !== "offline_access");
  if (unknown.length) throw new OAuthError("invalid_scope", `Unknown scope: ${unknown[0].slice(0, 50)}`);
  return MCP_SCOPE;
}

function normalizeResource(raw: string | null): string {
  if (!raw) return mcpResource();
  const r = raw.replace(/\/+$/, "");
  if (!acceptedResources().includes(r)) throw new OAuthError("invalid_target", "Unknown resource.");
  return r;
}

export async function createAuthCode(
  req: AuthorizeRequest,
  userId: string,
  db: Db = service(),
): Promise<string> {
  const code = randomToken(32);
  await db`
    insert into app.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
    values (${sha256Hex(code)}, ${req.client.client_id}, ${userId}, ${req.redirectUri}, ${req.codeChallenge}, ${req.scope},
            ${req.resource}, now() + make_interval(secs => ${AUTH_CODE_TTL_SECONDS}))
  `;
  return code;
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function issuePair(db: Db, p: { userId: string; clientId: string; scope: string; resource: string; familyId: string }): Promise<TokenResponse> {
  const access = newToken("oauth_access");
  const refresh = newToken("oauth_refresh");
  await db`
    insert into app.api_tokens (user_id, kind, token_hash, prefix, client_id, scopes, resource, family_id, expires_at)
    values
      (${p.userId}, 'oauth_access', ${access.hash}, ${access.prefix}, ${p.clientId}, ${[p.scope]}, ${p.resource}, ${p.familyId},
       now() + make_interval(secs => ${ACCESS_TOKEN_TTL_SECONDS})),
      (${p.userId}, 'oauth_refresh', ${refresh.hash}, ${refresh.prefix}, ${p.clientId}, ${[p.scope]}, ${p.resource}, ${p.familyId},
       now() + make_interval(days => ${REFRESH_TOKEN_TTL_DAYS}))
  `;
  await db`update app.oauth_clients set last_used_at = now() where client_id = ${p.clientId}`;
  return { access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh.token, scope: p.scope };
}

export async function exchangeAuthCode(
  p: { code: string; clientId: string; redirectUri: string | null; codeVerifier: string; resource?: string | null },
  db: Db = service(),
): Promise<TokenResponse> {
  return (await (db as ReturnType<typeof service>).begin(async (tx) => {
    const [row] = await tx<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string | null; expired: boolean; used_at: Date | null }[]>`
      select client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at < now() as expired, used_at
      from app.oauth_codes where code_hash = ${sha256Hex(p.code)} for update
    `;
    if (!row || row.client_id !== p.clientId) throw new OAuthError("invalid_grant", "Invalid authorization code.");
    if (row.used_at || row.expired) throw new OAuthError("invalid_grant", "The authorization code has expired or was already used.");
    if (p.redirectUri && p.redirectUri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match.");
    if (!pkceMatches(p.codeVerifier, row.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");
    if (p.resource && p.resource.replace(/\/+$/, "") !== row.resource) throw new OAuthError("invalid_target", "resource does not match the authorization request.");
    await tx`update app.oauth_codes set used_at = now() where code_hash = ${sha256Hex(p.code)}`;
    const [user] = await tx<{ ok: boolean }[]>`select is_active as ok from app.users where id = ${row.user_id}`;
    if (!user?.ok) throw new OAuthError("invalid_grant", "The user is not active.");
    return issuePair(tx, { userId: row.user_id, clientId: row.client_id, scope: row.scope || MCP_SCOPE, resource: row.resource ?? mcpResource(), familyId: randomUUID() });
  })) as TokenResponse;
}

export async function refreshTokens(p: { refreshToken: string; clientId: string }, db: Db = service()): Promise<TokenResponse> {
  const result = (await (db as ReturnType<typeof service>).begin(async (tx) => {
    const [row] = await tx<{ id: string; user_id: string; client_id: string; scopes: string[]; resource: string | null; family_id: string; revoked: boolean; expired: boolean }[]>`
      select id, user_id, client_id, scopes, resource, family_id, revoked_at is not null as revoked, expires_at < now() as expired
      from app.api_tokens where token_hash = ${sha256Hex(p.refreshToken)} and kind = 'oauth_refresh' for update
    `;
    if (!row || row.client_id !== p.clientId) throw new OAuthError("invalid_grant", "Invalid refresh token.");
    // A rotated refresh token was presented again: treat the family as compromised. The
    // revocation must commit, so it is returned rather than thrown inside the transaction.
    if (row.revoked) {
      await tx`update app.api_tokens set revoked_at = now() where family_id = ${row.family_id} and revoked_at is null`;
      return { reuse: true } as const;
    }
    if (row.expired) throw new OAuthError("invalid_grant", "The refresh token has expired.");
    const [user] = await tx<{ ok: boolean }[]>`select is_active as ok from app.users where id = ${row.user_id}`;
    const [client] = await tx<{ ok: boolean }[]>`select disabled_at is null as ok from app.oauth_clients where client_id = ${row.client_id}`;
    if (!user?.ok || !client?.ok) throw new OAuthError("invalid_grant", "The user or client is no longer active.");
    await tx`update app.api_tokens set revoked_at = now() where id = ${row.id}`;
    return issuePair(tx, { userId: row.user_id, clientId: row.client_id, scope: row.scopes[0] ?? MCP_SCOPE, resource: row.resource ?? mcpResource(), familyId: row.family_id });
  })) as TokenResponse | { reuse: true };
  if ("reuse" in result) throw new OAuthError("invalid_grant", "Refresh token reuse detected; sign in again.");
  return result;
}

/** RFC 7009: revokes a token (and, for OAuth tokens, its family). Unknown tokens are ignored. */
export async function revokeToken(token: string, db: Db = service()): Promise<void> {
  const [row] = await db<{ id: string; family_id: string | null }[]>`select id, family_id from app.api_tokens where token_hash = ${sha256Hex(token)}`;
  if (!row) return;
  if (row.family_id) await db`update app.api_tokens set revoked_at = now() where family_id = ${row.family_id} and revoked_at is null`;
  else await db`update app.api_tokens set revoked_at = now() where id = ${row.id} and revoked_at is null`;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const API_KEY_MAX_PER_USER = 20;

/** Creates an API key for the user. The key is returned once and never stored in clear. */
export async function createApiKey(userId: string, name: string, opts: { expiresInDays?: number | null; db?: Db } = {}): Promise<{ id: string; key: string; prefix: string }> {
  const db = opts.db ?? service();
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from app.api_tokens where user_id = ${userId} and kind = 'api_key' and revoked_at is null
  `;
  if (n >= API_KEY_MAX_PER_USER) throw new OAuthError("invalid_request", `At most ${API_KEY_MAX_PER_USER} active API keys per user.`);
  const t = newToken("api_key");
  const days = opts.expiresInDays ?? null;
  const [row] = await db<{ id: string }[]>`
    insert into app.api_tokens (user_id, kind, token_hash, prefix, name, expires_at)
    values (${userId}, 'api_key', ${t.hash}, ${t.prefix}, ${name.slice(0, 100)},
            ${days ? db`now() + make_interval(days => ${days})` : null})
    returning id
  `;
  return { id: row.id, key: t.token, prefix: t.prefix };
}

// ---------------------------------------------------------------------------
// Bearer token lookup
// ---------------------------------------------------------------------------

export type BearerToken = {
  tokenId: string;
  userId: string;
  kind: "api_key" | "oauth_access";
  clientId: string | null;
  resource: string | null;
};

export async function resolveBearer(token: string, db: Db = service()): Promise<BearerToken | null> {
  if (!/^btc_(pat|at)_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db<{ id: string; user_id: string; kind: "api_key" | "oauth_access"; client_id: string | null; resource: string | null; stale: boolean }[]>`
    select t.id, t.user_id, t.kind, t.client_id, t.resource,
           (t.last_used_at is null or t.last_used_at < now() - interval '5 minutes') as stale
    from app.api_tokens t
    left join app.oauth_clients c on c.client_id = t.client_id
    where t.token_hash = ${sha256Hex(token)} and t.kind in ('api_key', 'oauth_access')
      and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
      and (t.client_id is null or c.disabled_at is null)
  `;
  if (!row) return null;
  if (row.stale) await db`update app.api_tokens set last_used_at = now() where id = ${row.id}`;
  return { tokenId: row.id, userId: row.user_id, kind: row.kind, clientId: row.client_id, resource: row.resource };
}
