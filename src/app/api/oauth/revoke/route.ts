import { revokeToken } from "@/server/oauth/server";
import { CORS_HEADERS, preflight } from "@/server/oauth/http";

export const dynamic = "force-dynamic";

/** RFC 7009 token revocation. Always answers 200, whether or not the token was known. */
export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  const p = type.includes("application/json")
    ? new URLSearchParams(Object.entries((await req.json().catch(() => ({}))) as Record<string, string>))
    : new URLSearchParams(await req.text());
  const token = p.get("token");
  if (token && token.length < 200) await revokeToken(token);
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return preflight();
}
