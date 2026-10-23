import { service } from "@/server/db/client";
import { loadActiveUser } from "@/server/auth/session";
import { resolveBearer } from "@/server/oauth/server";
import { acceptedResources, protectedResourceMetadataUrl } from "@/server/oauth/config";
import { CORS_HEADERS, corsJson, preflight, requestOrigin } from "@/server/oauth/http";
import { handleBody, PARSE_ERROR, rpcError } from "@/server/mcp/server";
import { rateLimit } from "@/server/http/rate-limit";
import type { Caller } from "@/server/api/context";
import { reportMcpError } from "@/server/mcp/report";
import { logRequest, rpcMethodsOf } from "@/server/api/request-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 1_000_000;

function unauthorized(req: Request, error: "invalid_request" | "invalid_token" = "invalid_token"): Response {
  const meta = protectedResourceMetadataUrl(requestOrigin(req));
  return corsJson(
    { error, error_description: "Authorization required. Connect with OAuth or an API key." },
    401,
    { "WWW-Authenticate": `Bearer resource_metadata="${meta}", error="${error}"` },
  );
}

async function callerFor(req: Request): Promise<Caller | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const t = await resolveBearer(m[1]);
  if (!t) return null;
  // OAuth tokens must have been issued for this MCP server (RFC 8707 audience check).
  if (t.kind === "oauth_access" && !(t.resource && acceptedResources().includes(t.resource))) return null;
  const user = await loadActiveUser(service(), t.userId);
  if (!user) return null;
  return { user, via: "mcp", tokenId: t.tokenId, clientId: t.clientId };
}

/** POST /mcp (Streamable HTTP): JSON-RPC requests in, JSON responses out. */
export async function POST(req: Request) {
  const startedAt = Date.now();
  const caller = await callerFor(req);
  if (!caller) return unauthorized(req, req.headers.get("authorization") ? "invalid_token" : "invalid_request");
  let rpcMethods: string[] = [];
  const res = await (async (): Promise<Response> => {
    const limited = await rateLimit(`mcp:${caller.tokenId}`, 240, 60);
    if (!limited.allowed) return corsJson(rpcError(null, -32000, "Too many requests"), 429, { "Retry-After": String(limited.retryAfterSeconds) });

    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return corsJson(rpcError(null, -32600, "Request too large"), 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return corsJson(rpcError(null, PARSE_ERROR, "Parse error"), 400);
    }
    rpcMethods = rpcMethodsOf(body);
    const result = await handleBody(caller, body, (err, tool) => reportMcpError(err, tool));
    if (result === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return corsJson(result, 200);
  })();
  await logRequest({ via: "mcp", caller, req, status: res.status, startedAt, rpcMethods });
  return res;
}

/** No server-initiated streams: the server never sends requests or notifications. */
export function GET() {
  return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
}

export function OPTIONS() {
  return preflight();
}
