import "server-only";
import { ZodError } from "zod";
import { withUser, type Tx } from "@/server/db/client";
import { withAuditContext } from "@/server/audit";
import { can, type Capability } from "@/lib/permissions";
import type { SessionUser } from "@/server/auth/session";

/**
 * Shared service layer used by the REST API (/api/v1) and the MCP server. Every service
 * function takes a Caller, runs database work as that user under row-level security, and
 * records the channel ("api" or "mcp") on every audit entry it writes.
 */

export type Caller = {
  user: SessionUser;
  via: "web" | "api" | "mcp";
  /** The API key or OAuth access token used, when not a browser session. */
  tokenId: string | null;
  clientId: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found.`);
export const forbidden = (message = "You do not have permission to do that.") => new ApiError(403, "forbidden", message);

export function invalid(error: ZodError | string, details?: Record<string, unknown>): ApiError {
  if (typeof error === "string") return new ApiError(400, "invalid_request", error, details);
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return new ApiError(400, "invalid_request", "The request is invalid.", { fields });
}

export function requireCapability(caller: Caller, capability: Capability): void {
  if (!can(caller.user.role, capability)) throw forbidden();
}

/** Runs fn as the caller under RLS, with the caller's channel attached to audit entries. */
export function asCaller<T>(caller: Caller, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withAuditContext({ ipHash: null, via: caller.via === "web" ? "web" : caller.via }, () => withUser(caller.user.id, fn));
}

/** Runs fn with the caller's channel attached to audit entries (for modules that open their own transactions). */
export function inCallerContext<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
  return withAuditContext({ ipHash: null, via: caller.via === "web" ? "web" : caller.via }, fn);
}

/** Postgres permission errors (RLS, guard triggers) become 403s with the trigger's message when it is safe to show. */
export function mapDbError(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint_name?: string };
  if (e?.code === "42501") {
    const msg = String(e.message ?? "");
    if (msg.includes("admin cutover")) throw forbidden("This page was imported from Calendly. An admin takes it live from Admin > Import.");
    if (msg.includes("only admins")) throw forbidden("Only admins can change that.");
    throw forbidden();
  }
  if (e?.code === "23505") throw new ApiError(409, "conflict", "That conflicts with an existing record.", e.constraint_name ? { constraint: e.constraint_name } : undefined);
  if (e?.code === "23503") throw new ApiError(409, "conflict", "A referenced record does not exist or is still in use.");
  if (e?.code === "23514" || e?.code === "22P02") throw new ApiError(400, "invalid_request", "A value is not allowed.");
  throw err;
}
