import { describe, expect, it } from "vitest";
import { lookupAccount, normalizeEmail } from "@/server/home/lookup";
import { safeRelativePath } from "@/server/home/destination";

/** The n8n lookup client: request shape, timeout and every failure mode, with an injected fetch. */

const URL_ = "https://n8n.example.test/webhook/btc-scheduler/lookup";
const TOKEN = "t".repeat(40);
const config = { url: URL_, token: TOKEN };
const BODY = { opportunities: [], leads: [{ createdAt: "2026-01-01T00:00:00Z", owner: null }] };

type Call = { url: string; init: RequestInit };

function recorder(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetchImpl };
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("lookupAccount", () => {
  it("posts the normalized email with the bearer token and parses the answer", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse(BODY));
    const out = await lookupAccount("  Ana@Example.COM ", { config, fetchImpl });
    expect(out).toEqual({ ok: true, data: BODY });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: "ana@example.com" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(normalizeEmail(" X@Y.Z ")).toBe("x@y.z");
  });

  it("skips the call without a token", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse(BODY));
    expect(await lookupAccount("ana@example.com", { config: { url: URL_, token: undefined }, fetchImpl })).toEqual({ ok: false, reason: "no_token" });
    expect(calls).toHaveLength(0);
  });

  it("times out", async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    expect(await lookupAccount("ana@example.com", { config, fetchImpl, timeoutMs: 50 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports non-2xx answers by status code", async () => {
    for (const status of [401, 404, 500, 502]) {
      const { fetchImpl } = recorder(() => jsonResponse({ error: "lookup_failed" }, status));
      expect(await lookupAccount("ana@example.com", { config, fetchImpl })).toEqual({ ok: false, reason: `status_${status}` });
    }
  });

  it("rejects bodies that are not the contract", async () => {
    const bodies = [
      () => new Response("<html>not json</html>", { status: 200 }),
      () => jsonResponse({ opportunities: "none", leads: [] }),
      () => jsonResponse({ leads: [] }),
      () => jsonResponse([]),
      () => new Response("x".repeat(300_000), { status: 200 }),
    ];
    for (const body of bodies) {
      const { fetchImpl } = recorder(body);
      expect(await lookupAccount("ana@example.com", { config, fetchImpl })).toEqual({ ok: false, reason: "invalid_response" });
    }
  });

  it("reports network errors without details", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND n8n.example.test");
    };
    expect(await lookupAccount("ana@example.com", { config, fetchImpl })).toEqual({ ok: false, reason: "network" });
  });
});

describe("safeRelativePath", () => {
  it("returns only same-site relative paths", () => {
    expect(safeRelativePath("/ana/15min")).toBe("/ana/15min");
    expect(safeRelativePath("/t/sales/intro/es")).toBe("/t/sales/intro/es");
    for (const bad of [null, "", "ana/15min", "//evil.example", "https://evil.example/x", "/\\evil.example", "/a b", "/a\nb"]) {
      expect(safeRelativePath(bad)).toBeNull();
    }
  });
});
