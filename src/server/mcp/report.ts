import "server-only";

type Reporter = (err: unknown, info: { source: "mcp"; route: string; method: string; context?: Record<string, unknown> }) => void;

let reporter: Reporter = (err) => console.error("[mcp] tool failed", (err as Error)?.name ?? "Error");

/** Lets the error log module receive unexpected MCP tool errors without a hard dependency. */
export function setMcpErrorReporter(fn: Reporter): void {
  reporter = fn;
}

export function reportMcpError(err: unknown, tool: string): void {
  try {
    reporter(err, { source: "mcp", route: "/mcp", method: "tools/call", context: { tool } });
  } catch {
    // Reporting must never break a response.
  }
}
