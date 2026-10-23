import "server-only";
import { ZodError } from "zod";
import { NextResponse } from "next/server";
import { resolveBearer } from "@/server/oauth/server";
import { loadActiveUser } from "@/server/auth/session";
import { service } from "@/server/db/client";
import { rateLimit } from "@/server/http/rate-limit";
import { ApiError, type Caller } from "@/server/api/context";

/**
 * HTTP plumbing for the REST API (/api/v1). Requests authenticate with an API key
 * ("Authorization: Bearer btc_pat_..."), act as the key's owner with that user's current role,
 * and are limited to RATE_LIMIT requests per minute per key.
 */

const RATE_LIMIT = 120;
const MAX_BODY_BYTES = 1_000_000;

export type ErrorReporter = (err: unknown, info: { source: "api" | "mcp"; route: string; method: string }) => void;

let reportError: ErrorReporter = (err) => console.error("[api] unexpected error", (err as Error)?.name ?? "Error");

/** Lets the error log module receive unexpected errors without a hard dependency. */
export function setApiErrorReporter(fn: ErrorReporter): void {
  reportError = fn;
}

export function apiJson(body: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function apiErrorResponse(err: ApiError, headers?: Record<string, string>): NextResponse {
  return apiJson({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status, headers);
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

/** Resolves the API key on the request to a Caller, or null. */
export async function apiCaller(req: Request): Promise<Caller | null> {
  const token = bearer(req);
  if (!token) return null;
  const t = await resolveBearer(token);
  if (!t || t.kind !== "api_key") return null;
  const user = await loadActiveUser(service(), t.userId);
  if (!user) return null;
  return { user, via: "api", tokenId: t.tokenId, clientId: null };
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "The request body is too large.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

/** Search parameters as typed values: numbers and booleans are converted, arrays are not supported. */
export function queryObject(req: Request, numeric: string[] = [], booleans: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URL(req.url).searchParams) {
    if (numeric.includes(k)) out[k] = v === "" ? undefined : Number(v);
    else if (booleans.includes(k)) out[k] = v === "true" || v === "1";
    else out[k] = v;
  }
  return out;
}

type Handler<C> = (args: { req: Request; caller: Caller; ctx: C }) => Promise<unknown>;

/**
 * Wraps a REST handler: authentication, rate limiting, JSON errors. Returning undefined gives
 * 204; return { status, body } for other statuses.
 */
export function apiRoute<C = unknown>(handler: Handler<C>, opts: { successStatus?: number } = {}) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const route = new URL(req.url).pathname;
    try {
      const caller = await apiCaller(req);
      if (!caller) {
        return apiErrorResponse(new ApiError(401, "unauthorized", "Provide a valid API key: Authorization: Bearer btc_pat_..."), {
          "WWW-Authenticate": 'Bearer realm="BTC Scheduler API"',
        });
      }
      const limited = await rateLimit(`api:${caller.tokenId}`, RATE_LIMIT, 60);
      if (!limited.allowed) {
        return apiErrorResponse(new ApiError(429, "rate_limited", "Too many requests."), { "Retry-After": String(limited.retryAfterSeconds) });
      }
      const result = await handler({ req, caller, ctx });
      if (result === undefined) return new Response(null, { status: 204 });
      if (result && typeof result === "object" && "status" in result && "body" in result) {
        const r = result as { status: number; body: unknown };
        return apiJson(r.body, r.status);
      }
      return apiJson({ data: result }, opts.successStatus ?? 200);
    } catch (err) {
      if (err instanceof ApiError) return apiErrorResponse(err);
      if (err instanceof ZodError) return apiErrorResponse(new ApiError(400, "invalid_request", "The request is invalid."));
      reportError(err, { source: "api", route, method: req.method });
      return apiErrorResponse(new ApiError(500, "internal_error", "Something went wrong. The error has been logged."));
    }
  };
}
