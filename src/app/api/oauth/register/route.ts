import { hashIp } from "@/server/http/ip";
import { rateLimit } from "@/server/http/rate-limit";
import { OAuthError, registerClient } from "@/server/oauth/server";
import { corsJson, preflight } from "@/server/oauth/http";

export const dynamic = "force-dynamic";

/** RFC 7591 dynamic client registration. Callback URLs must be on the admin allowlist. */
export async function POST(req: Request) {
  const limited = await rateLimit(`oauth:register:${hashIp(req.headers)}`, 20, 3600);
  if (!limited.allowed) return corsJson({ error: "invalid_request", error_description: "Too many registrations." }, 429, { "Retry-After": String(limited.retryAfterSeconds) });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return corsJson({ error: "invalid_client_metadata", error_description: "Send client metadata as JSON." }, 400);
  }
  try {
    const client = await registerClient(body ?? {});
    return corsJson(
      {
        client_id: client.client_id,
        client_name: client.name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      201,
    );
  } catch (err) {
    if (err instanceof OAuthError) return corsJson({ error: err.error, error_description: err.description }, err.status);
    throw err;
  }
}

export function OPTIONS() {
  return preflight();
}
