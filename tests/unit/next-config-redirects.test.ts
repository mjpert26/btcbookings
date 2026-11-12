import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Rule = { source: string; has?: { type: string; value: string }[]; destination: string; permanent: boolean };

async function redirects(): Promise<Rule[]> {
  const mod = await import("../../next.config");
  return ((await mod.default.redirects?.()) ?? []) as Rule[];
}

/** Turns a rule's "/:path(<regex>)" source into an anchored RegExp over the request path. */
function pathMatcher(source: string): RegExp {
  const m = /^\/:path\((.*)\)$/.exec(source);
  if (!m) throw new Error(`unexpected source ${source}`);
  return new RegExp(`^/(${m[1]})$`);
}

describe("legacy host redirects", () => {
  it("sends page requests on a former host to APP_BASE_URL and leaves integrations alone", async () => {
    vi.stubEnv("APP_BASE_URL", "https://book.bigthinkcapital.com");
    vi.stubEnv("APP_LEGACY_HOSTS", "btcbookings.vercel.app, BOOK.bigthinkcapital.com, bad host");
    const rules = await redirects();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.has).toEqual([{ type: "host", value: "btcbookings.vercel.app" }]);
    expect(rule.destination).toBe("https://book.bigthinkcapital.com/:path");
    expect(rule.permanent).toBe(false);

    const re = pathMatcher(rule.source);
    for (const path of ["/", "/mike-perticone/30min", "/b/abc123", "/login", "/admin/settings", "/mcpx"]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ["/api/public/book", "/api/graph/notifications", "/api/cron/jobs", "/_next/static/chunk.js", "/.well-known/oauth-authorization-server", "/mcp", "/mcp/"]) {
      expect(re.test(path), path).toBe(false);
    }
  });

  it("adds nothing when no former hosts are configured", async () => {
    vi.stubEnv("APP_BASE_URL", "https://book.bigthinkcapital.com");
    vi.stubEnv("APP_LEGACY_HOSTS", "");
    vi.stubEnv("MCP_BASE_URL", "");
    expect(await redirects()).toEqual([]);
  });
});
