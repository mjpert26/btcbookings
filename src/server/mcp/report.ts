import "server-only";
import { logErrorAfterResponse } from "@/server/errors/log";

/**
 * Records an unexpected MCP tool error in the error log after the response has been sent, so
 * a slow log write never delays the tool result. Never throws.
 */
export async function reportMcpError(err: unknown, tool: string): Promise<void> {
  await logErrorAfterResponse(err, { source: "mcp", route: "/mcp", method: "tools/call", context: { tool } });
}
