import "server-only";
import { after } from "next/server";
import { service, type Db } from "@/server/db/client";
import { normalizeRoute } from "@/server/errors/sanitize";
import { hashIp } from "@/server/http/ip";
import type { Caller } from "@/server/api/context";

/**
 * Request log for the REST API and the MCP server (app.api_request_log). Only metadata is
 * stored: caller, key or app, method, normalized route, JSON-RPC methods, status and
 * duration. Bodies, query strings and headers are never stored.
 */

export type RequestLogEntry = {
  via: "api" | "mcp";
  caller: Caller;
  req: Request;
  status: number;
  startedAt: number;
  /** JSON-RPC methods of an MCP request, e.g. "tools/list" or "tools/call list_bookings". */
  rpcMethods?: string[];
};

const MAX_RPC_METHODS = 50;

/** JSON-RPC method names in an MCP request body, with the tool name for tools/call. */
export function rpcMethodsOf(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of messages.slice(0, MAX_RPC_METHODS)) {
    if (!m || typeof m !== "object") continue;
    const method = (m as { method?: unknown }).method;
    if (typeof method !== "string") continue;
    const tool = (m as { params?: { name?: unknown } }).params?.name;
    const label = method === "tools/call" && typeof tool === "string" ? `${method} ${tool}` : method;
    out.push(label.replace(/[^\w/ .:-]/g, "").slice(0, 100));
  }
  return out;
}

type Row = {
  via: "api" | "mcp";
  userId: string;
  tokenId: string | null;
  clientId: string | null;
  method: string;
  route: string;
  rpcMethods: string[];
  status: number;
  durationMs: number;
  ipHash: string;
};

function toRow(e: RequestLogEntry): Row {
  return {
    via: e.via,
    userId: e.caller.user.id,
    tokenId: e.caller.tokenId,
    clientId: e.caller.clientId,
    method: e.req.method.slice(0, 16),
    route: normalizeRoute(new URL(e.req.url).pathname),
    rpcMethods: (e.rpcMethods ?? []).slice(0, MAX_RPC_METHODS),
    status: e.status,
    durationMs: Math.max(0, Math.round(Date.now() - e.startedAt)),
    ipHash: hashIp(e.req.headers),
  };
}

async function insertRow(r: Row, db: Db = service()): Promise<void> {
  try {
    await db`
      insert into app.api_request_log (via, user_id, token_id, client_id, method, route, rpc_methods, status, duration_ms, ip_hash)
      values (${r.via}, ${r.userId}, ${r.tokenId}, ${r.clientId}, ${r.method}, ${r.route}, ${r.rpcMethods}, ${r.status}, ${r.durationMs}, ${r.ipHash})
    `;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "unknown";
    console.error(`[request-log] could not record a request (via=${r.via}, code=${code})`);
  }
}

/**
 * Records the request after the response has been sent. Outside a Next.js request (tests and
 * scripts), `after` is unavailable and the entry is written before returning instead.
 */
export async function logRequest(e: RequestLogEntry): Promise<void> {
  let row: Row;
  try {
    row = toRow(e);
  } catch {
    return;
  }
  try {
    after(() => insertRow(row));
  } catch {
    await insertRow(row);
  }
}
