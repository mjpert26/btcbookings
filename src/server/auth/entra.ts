import "server-only";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/server/env";
import { randomToken } from "@/server/crypto/random";

/**
 * Microsoft Entra ID (single tenant) OIDC: authorization code flow with PKCE,
 * confidential client. Produces both the sign-in identity and the Graph tokens.
 */
export const GRAPH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "OnlineMeetings.ReadWrite",
];

const authority = () => `https://login.microsoftonline.com/${env().ENTRA_TENANT_ID}`;
export const redirectUri = () => `${env().APP_BASE_URL}/api/auth/callback`;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(p: {
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string;
  prompt?: "select_account" | "consent" | "login";
}): string {
  const u = new URL(`${authority()}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", env().ENTRA_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", GRAPH_SCOPES.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
  u.searchParams.set("prompt", p.prompt ?? "select_account");
  return u.toString();
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: Date;
  scopes: string[];
};

export class TokenError extends Error {
  constructor(
    message: string,
    /** True when the grant can never succeed again (revoked consent, expired refresh token). */
    readonly permanent: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

// AADSTS codes that mean the refresh token or consent is gone for good.
const PERMANENT_AADSTS = ["AADSTS50173", "AADSTS65001", "AADSTS70000", "AADSTS700082", "AADSTS50076", "AADSTS50079", "AADSTS53003", "AADSTS50057", "AADSTS50034"];

export function classifyTokenError(status: number, body: { error?: string; error_description?: string }): TokenError {
  const code = body.error ?? `http_${status}`;
  const desc = body.error_description ?? "";
  const permanent =
    code === "invalid_grant" ||
    code === "interaction_required" ||
    code === "consent_required" ||
    PERMANENT_AADSTS.some((c) => desc.includes(c));
  // Do not include the description verbatim: it can echo correlation ids but never tokens.
  const summary = desc.split("\r\n")[0]?.slice(0, 200) ?? "";
  return new TokenError(`Token endpoint error ${code}: ${summary}`, permanent, code);
}

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: env().ENTRA_CLIENT_ID,
    client_secret: env().ENTRA_CLIENT_SECRET,
    scope: GRAPH_SCOPES.join(" "),
    ...params,
  });
  let res: Response;
  try {
    res = await fetchImpl(`${authority()}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new TokenError(`Token endpoint unreachable: ${(err as Error).message}`, false, "network");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw classifyTokenError(res.status, json as { error?: string; error_description?: string });
  return {
    accessToken: String(json.access_token),
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
    expiresAt: new Date(Date.now() + (Number(json.expires_in ?? 3600) - 60) * 1000),
    scopes: String(json.scope ?? "").split(" ").filter(Boolean),
  };
}

export function exchangeCode(code: string, codeVerifier: string, fetchImpl?: typeof fetch): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri() },
    fetchImpl,
  );
}

export function refreshTokens(refreshToken: string, fetchImpl?: typeof fetch): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export type IdentityClaims = {
  oid: string;
  tid: string;
  email: string;
  name: string;
  preferredUsername: string;
};

export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdentityClaims> {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${authority()}/discovery/v2.0/keys`));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: `${authority()}/v2.0`,
    audience: env().ENTRA_CLIENT_ID,
    clockTolerance: 60,
  });
  return claimsFromPayload(payload, expectedNonce);
}

export function claimsFromPayload(payload: JWTPayload, expectedNonce: string): IdentityClaims {
  if (payload.nonce !== expectedNonce) throw new Error("ID token nonce mismatch");
  if (payload.tid !== env().ENTRA_TENANT_ID) throw new Error("ID token is from another tenant");
  const oid = String(payload.oid ?? "");
  const preferred = String(payload.preferred_username ?? "");
  const email = String(payload.email ?? preferred).toLowerCase();
  if (!oid || !email) throw new Error("ID token is missing oid or email");
  return { oid, tid: String(payload.tid), email, name: String(payload.name ?? email), preferredUsername: preferred };
}
