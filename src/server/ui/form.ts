import "server-only";
import { headers } from "next/headers";
import type { z } from "zod";
import type { ActionState } from "@/lib/form-state";
import { hashIp } from "@/server/http/ip";

export function ok(message: string): ActionState {
  return { status: "success", message, ts: Date.now() };
}

export function fail(message: string, fieldErrors?: Record<string, string>): ActionState {
  return { status: "error", message, fieldErrors, ts: Date.now() };
}

/** Converts a Zod error into a flat field-name map (first message per field). */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export function invalid(error: z.ZodError, message = "Please fix the highlighted fields."): ActionState {
  return fail(message, zodFieldErrors(error));
}

/** Reads a form field as a trimmed string ("" when missing). */
export function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

/** Checkbox and Switch fields post "on" when checked. */
export function bool(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === "on" || v === "true" || v === "1";
}

/** Parses a JSON field written by a client-side editor. Returns undefined on bad JSON. */
export function json(fd: FormData, name: string): unknown {
  const v = fd.get(name);
  if (typeof v !== "string" || v === "") return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

export async function requestIpHash(): Promise<string> {
  return hashIp(await headers());
}

/** Postgres error codes the UI maps to friendly messages. */
export function pgCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  if (err && typeof err === "object" && "constraint_name" in err) {
    return String((err as { constraint_name: unknown }).constraint_name);
  }
  return undefined;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
