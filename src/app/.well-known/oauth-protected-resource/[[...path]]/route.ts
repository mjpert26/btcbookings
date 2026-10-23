import { env } from "@/server/env";
import { mcpResource, protectedResourceMetadata } from "@/server/oauth/config";
import { corsJson, preflight, requestOrigin } from "@/server/oauth/http";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata for the MCP server, at
 * /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp.
 */
export function GET(req: Request) {
  const origin = requestOrigin(req);
  const resource = origin === env().APP_BASE_URL ? `${origin}/mcp` : mcpResource();
  return corsJson(protectedResourceMetadata(resource), 200, { "Cache-Control": "public, max-age=3600" });
}

export function OPTIONS() {
  return preflight();
}
