import { authorizationServerMetadata } from "@/server/oauth/config";
import { corsJson, preflight } from "@/server/oauth/http";

export const dynamic = "force-dynamic";

/** Some MCP clients look here first; the same OAuth metadata is served (no ID tokens are issued). */
export function GET() {
  return corsJson(authorizationServerMetadata(), 200, { "Cache-Control": "public, max-age=3600" });
}

export function OPTIONS() {
  return preflight();
}
