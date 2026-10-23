import { loadTeamLogo } from "@/server/teams/branding";

export const dynamic = "force-dynamic";

/**
 * Headers for every response from this route. The body is an image, never a document, so the
 * policy forbids everything a document could do, and nosniff stops browsers from guessing a
 * different type.
 */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'; frame-ancestors 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Referrer-Policy": "no-referrer",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
}

/** Whether an If-None-Match header matches the ETag (weak comparison, as RFC 9110 requires for GET). */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

/**
 * GET /api/public/team-logo/[teamId]: a partner's uploaded logo. Links carry ?v=<hash prefix>;
 * when it matches the stored logo the response may be cached for a year, otherwise briefly.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/public/team-logo/[teamId]">) {
  const { teamId } = await ctx.params;
  if (!UUID_RE.test(teamId)) return notFound();
  const logo = await loadTeamLogo(teamId);
  if (!logo) return notFound();

  const etag = `"${logo.sha256}"`;
  const version = new URL(req.url).searchParams.get("v");
  const pinned = version !== null && version.length >= 8 && logo.sha256.startsWith(version);
  const headers = {
    ...BASE_HEADERS,
    ETag: etag,
    "Last-Modified": logo.updatedAt.toUTCString(),
    "Cache-Control": pinned ? "public, max-age=31536000, immutable" : "public, max-age=300, stale-while-revalidate=86400",
  };
  if (matches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(logo.bytes), {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": logo.contentType,
      "Content-Length": String(logo.bytes.byteLength),
      "Content-Disposition": `inline; filename="logo.${EXT[logo.contentType]}"`,
    },
  });
}
