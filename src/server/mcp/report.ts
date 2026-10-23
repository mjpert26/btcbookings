import "server-only";
import { logError } from "@/server/errors/log";

/** Records an unexpected MCP tool error in the error log. Never throws. */
export async function reportMcpError(err: unknown, tool: string): Promise<void> {
  await logError(err, { source: "mcp", route: "/mcp", method: "tools/call", context: { tool } });
}
