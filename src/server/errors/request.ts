import "server-only";
import type { Instrumentation } from "next";
import { logError } from "@/server/errors/log";
import type { ErrorSource } from "@/server/errors/sanitize";

type RequestInfo = Parameters<Instrumentation.onRequestError>[1];
type RequestContext = Parameters<Instrumentation.onRequestError>[2];

/** Maps a Next.js request error context to an error log source. */
export function requestErrorSource(routeType: RequestContext["routeType"] | undefined, path: string): ErrorSource {
  if (routeType === "action") return "action";
  if (routeType === "render") return "page";
  const pathname = path.split("?", 1)[0] ?? "";
  if (pathname.startsWith("/api/cron/")) return "cron";
  if (pathname.startsWith("/api/v1/") || pathname === "/api/v1") return "api";
  if (pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname.startsWith("/api/mcp")) return "mcp";
  return "route";
}

/**
 * Called from the onRequestError instrumentation hook for errors in Server Components,
 * route handlers, server actions and the proxy. Stores the route file pattern (for example
 * "/(public)/b/[token]/page") instead of the request path, so tokens in URLs are never kept.
 * Headers are not stored.
 */
export async function logRequestError(err: unknown, request: RequestInfo, context: RequestContext): Promise<void> {
  const path = request?.path ?? "";
  await logError(err, {
    source: requestErrorSource(context?.routeType, path),
    route: context?.routePath || path || null,
    method: request?.method ?? null,
    context: {
      routeType: context?.routeType ?? null,
      renderSource: context?.renderSource ?? null,
      revalidateReason: context?.revalidateReason ?? null,
      routerKind: context?.routerKind ?? null,
    },
  });
}
