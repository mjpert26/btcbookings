import { hashIp } from "@/server/http/ip";
import { rateLimit } from "@/server/http/rate-limit";
import { exchangeAuthCode, OAuthError, refreshTokens } from "@/server/oauth/server";
import { corsJson, preflight } from "@/server/oauth/http";

export const dynamic = "force-dynamic";

async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v === "string") as [string, string][]);
  }
  return new URLSearchParams(await req.text());
}

/** OAuth 2.1 token endpoint: authorization_code (with PKCE) and refresh_token grants, public clients. */
export async function POST(req: Request) {
  const limited = await rateLimit(`oauth:token:${hashIp(req.headers)}`, 60, 60);
  if (!limited.allowed) return corsJson({ error: "invalid_request", error_description: "Too many requests." }, 429, { "Retry-After": String(limited.retryAfterSeconds) });
  const p = await readParams(req);
  const clientId = p.get("client_id") ?? "";
  try {
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required.", 401);
    const grant = p.get("grant_type");
    if (grant === "authorization_code") {
      const tokens = await exchangeAuthCode({
        code: p.get("code") ?? "",
        clientId,
        redirectUri: p.get("redirect_uri"),
        codeVerifier: p.get("code_verifier") ?? "",
        resource: p.get("resource"),
      });
      return corsJson(tokens, 200, { Pragma: "no-cache" });
    }
    if (grant === "refresh_token") {
      const tokens = await refreshTokens({ refreshToken: p.get("refresh_token") ?? "", clientId });
      return corsJson(tokens, 200, { Pragma: "no-cache" });
    }
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch (err) {
    if (err instanceof OAuthError) return corsJson({ error: err.error, error_description: err.description }, err.status);
    throw err;
  }
}

export function OPTIONS() {
  return preflight();
}
