import "server-only";
import { ApiError, type Caller } from "@/server/api/context";
import { inputJsonSchema, toolsFor, TOOLS } from "@/server/mcp/tools";

/**
 * Minimal, stateless Model Context Protocol server (Streamable HTTP transport, JSON responses).
 * Implements initialize, ping, tools/list and tools/call. No server-sent event streams and no
 * sessions: every request carries the caller's bearer token.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: "btc-scheduler", title: "BTC Scheduler", version: "1.0.0" };

const INSTRUCTIONS = [
  "BTC Scheduler is Big Think Capital's scheduling system (it replaces Calendly).",
  "All tools act as the signed-in user with their role: Agents see only their own bookings and pages, Managers can read everything, Admins can change everything.",
  "Times are ISO 8601. To book a meeting, call list_booking_pages to find the page, find_available_times for open slots, then schedule_meeting.",
  "Scheduling, cancelling and rescheduling notify the invitee by email and update Outlook, so confirm details with the user first.",
].join(" ");

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isRequest(m: unknown): m is JsonRpcRequest {
  return Boolean(m && typeof m === "object" && (m as JsonRpcRequest).jsonrpc === "2.0" && typeof (m as JsonRpcRequest).method === "string");
}

export type ToolErrorReporter = (err: unknown, tool: string) => void | Promise<void>;

export async function handleMessage(caller: Caller, message: unknown, report?: ToolErrorReporter): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) return rpcError(null, INVALID_REQUEST, "Invalid JSON-RPC request");
  const isNotification = message.id === undefined;
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
  const id = message.id ?? null;
  const params = (message.params ?? {}) as Record<string, unknown>;

  switch (message.method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: toolsFor(caller).map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: inputJsonSchema(t),
            annotations: { title: t.title, ...t.annotations },
          })),
        },
      };
    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = toolsFor(caller).find((t) => t.name === name);
      if (!tool) {
        const exists = TOOLS.some((t) => t.name === name);
        return exists ? toolResult(id, { error: "Your role does not allow this tool." }, true) : rpcError(id, INVALID_PARAMS, `Unknown tool: ${name.slice(0, 100)}`);
      }
      const parsed = tool.input.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`);
        return toolResult(id, { error: "Invalid arguments.", issues }, true);
      }
      try {
        const out = await tool.run(caller, parsed.data as never);
        return toolResult(id, out, false);
      } catch (err) {
        if (err instanceof ApiError) return toolResult(id, { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, true);
        await report?.(err, name);
        return toolResult(id, { error: "Something went wrong. The error has been logged." }, true);
      }
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method.slice(0, 100)}`);
  }
}

function toolResult(id: JsonRpcId, value: unknown, isError: boolean): JsonRpcResponse {
  const structured = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value ?? null };
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }], structuredContent: structured, isError },
  };
}

/** Handles a request body: a single message or a batch. Returns null when only notifications were sent. */
export async function handleBody(caller: Caller, body: unknown, report?: ToolErrorReporter): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (!body.length) return rpcError(null, INVALID_REQUEST, "Empty batch");
    const out = (await Promise.all(body.slice(0, 50).map((m) => handleMessage(caller, m, report)))).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleMessage(caller, body, report);
}

export { PARSE_ERROR, INTERNAL_ERROR, rpcError };
