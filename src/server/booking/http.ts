import "server-only";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { sha256Hex } from "@/server/crypto/random";
import { rateLimit } from "@/server/http/rate-limit";
import { BookingError } from "@/server/booking/types";

/** Helpers shared by the public booking API routes (/api/public/*). */

export const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

export type PublicErrorCode =
  | "invalid"
  | "not_found"
  | "slot_taken"
  | "not_allowed"
  | "rate_limited"
  | "verification_failed"
  | "forbidden"
  | "error";

export function jsonError(
  status: number,
  error: PublicErrorCode,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** POSTs must come from this app's own origin (CSRF defense for the public forms). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env().APP_BASE_URL).origin;
  } catch {
    return false;
  }
}

/** Reads a JSON body with a size cap. Returns undefined when it is missing or malformed. */
export async function readJson(req: Request, maxBytes = 32_768): Promise<unknown> {
  const text = await req.text();
  if (!text || text.length > maxBytes) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Applies each limit in order; returns a 429 response for the first one exceeded. */
export async function limit(rules: { key: string; max: number; windowSeconds: number }[]): Promise<NextResponse | null> {
  for (const r of rules) {
    const res = await rateLimit(r.key, r.max, r.windowSeconds);
    if (!res.allowed) {
      return jsonError(429, "rate_limited", {}, { "Retry-After": String(res.retryAfterSeconds) });
    }
  }
  return null;
}

export function emailKey(email: string): string {
  return sha256Hex(email.trim().toLowerCase()).slice(0, 32);
}

/** Maps service errors to uniform public responses. Unknown errors are logged without input. */
export function mapBookingError(err: unknown, route: string): NextResponse {
  if (err instanceof BookingError) {
    switch (err.code) {
      case "invalid":
        return jsonError(400, "invalid", err.fieldErrors ? { fields: err.fieldErrors } : {});
      case "not_found":
        return jsonError(404, "not_found");
      case "slot_taken":
        return jsonError(409, "slot_taken");
      case "not_allowed":
        return jsonError(409, "not_allowed");
    }
  }
  console.error(`[${route}] unexpected error: ${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? ""}`.slice(0, 500));
  return jsonError(500, "error");
}
