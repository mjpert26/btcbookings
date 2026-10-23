import { authorizationServerMetadata } from "@/server/oauth/config";
import { corsJson, preflight } from "@/server/oauth/http";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization server metadata. */
export function GET() {
  return corsJson(authorizationServerMetadata(), 200, { "Cache-Control": "public, max-age=3600" });
}

export function OPTIONS() {
  return preflight();
}
