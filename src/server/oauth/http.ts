import "server-only";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { mcpOrigin } from "@/server/oauth/config";

/** CORS for OAuth and MCP endpoints: bearer tokens only, never cookies, so any origin may call. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function corsJson(body: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store", ...headers } });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The public origin a request arrived on: the MCP host or the app host. */
export function requestOrigin(req: Request): string {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").toLowerCase();
  const mcp = new URL(mcpOrigin());
  return host && host === mcp.host.toLowerCase() ? mcp.origin : env().APP_BASE_URL;
}
