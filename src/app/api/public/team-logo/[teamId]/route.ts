import { loadTeamLogo, loadTeamLogoMeta, teamLogoPath } from "@/server/teams/branding";

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

/** Sends the client to the canonical URL of the current logo. Cached briefly, since the logo can change. */
function toCanonical(teamId: string, sha256: string): Response {
  return new Response(null, {
    status: 307,
    headers: { ...BASE_HEADERS, Location: teamLogoPath(teamId, sha256), "Cache-Control": "public, max-age=300" },
  });
}

/** Whether an If-None-Match header matches the ETag (weak comparison, as RFC 9110 requires for GET). */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

/**
 * GET /api/public/team-logo/[teamId]: a partner's uploaded logo.
 *
 * The image is served only at its canonical URL, `?v=<first 16 hex characters of its hash>`
 * with no other query parameters (see teamLogoPath), and may be cached there for a year. Any
 * other URL, including an old version or a random value, is redirected there, so varying the
 * query string cannot bypass the CDN cache to make the route read the image again. Redirects
 * and 304 responses read only the logo metadata, never the bytes.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/public/team-logo/[teamId]">) {
  const { teamId } = await ctx.params;
  if (!UUID_RE.test(teamId)) return notFound();
  const meta = await loadTeamLogoMeta(teamId);
  if (!meta) return notFound();

  const params = new URL(req.url).searchParams;
  const canonical = [...params.keys()].length === 1 && params.get("v") === meta.sha256.slice(0, 16);
  if (!canonical) return toCanonical(teamId, meta.sha256);

  const etag = `"${meta.sha256}"`;
  const headers = {
    ...BASE_HEADERS,
    ETag: etag,
    "Last-Modified": meta.updatedAt.toUTCString(),
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  if (matches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });

  const logo = await loadTeamLogo(teamId);
  if (!logo) return notFound();
  // The logo was replaced between the two reads.
  if (logo.sha256 !== meta.sha256) return toCanonical(teamId, logo.sha256);
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
