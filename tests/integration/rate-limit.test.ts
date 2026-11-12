import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { rateLimit } from "@/server/http/rate-limit";
import { turnstileHostnames, verifyTurnstile } from "@/server/http/turnstile";
import { resetEnvCache } from "@/server/env";

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
});

describe("rate limiter", () => {
  it("allows up to the limit within a window, including under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit("book:abc", 10, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.every((r) => r.retryAfterSeconds > 0 && r.retryAfterSeconds <= 60)).toBe(true);
    expect((await rateLimit("book:other", 10, 60)).allowed).toBe(true);
  });
});

describe("turnstile", () => {
  const cf = (json: Record<string, unknown>, status = 200) =>
    (async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

  it("skips verification when unconfigured, in every environment", async () => {
    expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: true });
    const prev = { node: process.env.NODE_ENV };
    vi.stubEnv("NODE_ENV", "production");
    try {
      resetEnvCache();
      expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: true });
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
    expect(process.env.NODE_ENV).toBe(prev.node);
  });

  it("requires success, the form's action and an accepted hostname once a secret is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    vi.stubEnv("TURNSTILE_HOSTNAMES", "book.bigthinkcapital.com, btcbookings.vercel.app");
    try {
      resetEnvCache();
      expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: false, reason: "missing_token" });
      expect(await verifyTurnstile("", { action: "book" })).toEqual({ ok: false, reason: "missing_token" });
      const ok = cf({ success: true, action: "book", hostname: "book.bigthinkcapital.com" });
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: ok })).toEqual({ ok: true });
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: true, action: "book", hostname: "BTCBOOKINGS.vercel.app" }) })).toEqual({ ok: true });
      // A token minted for another form, or on another site, is refused.
      expect(await verifyTurnstile("token", { action: "cancel", fetchImpl: ok })).toEqual({ ok: false, reason: "action_mismatch" });
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: true, action: "book", hostname: "evil.example.com" }) })).toEqual({
        ok: false,
        reason: "hostname_mismatch",
      });
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: true, action: "book" }) })).toEqual({ ok: false, reason: "hostname_mismatch" });
      // Tokens are single-use: Cloudflare answers a replay with timeout-or-duplicate.
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: false, "error-codes": ["timeout-or-duplicate"] }) })).toEqual({
        ok: false,
        reason: "timeout-or-duplicate",
      });
      // A non-2xx answer or a network failure fails closed.
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: true, action: "book", hostname: "book.bigthinkcapital.com" }, 500) })).toEqual({
        ok: false,
        reason: "turnstile_unreachable",
      });
      const down = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: down })).toEqual({ ok: false, reason: "turnstile_unreachable" });
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  });

  it("accepts the APP_BASE_URL hostname by default and never localhost in production", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    try {
      resetEnvCache();
      expect([...turnstileHostnames()]).toEqual(["localhost"]);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("TURNSTILE_HOSTNAMES", "localhost,127.0.0.1,book.bigthinkcapital.com");
      resetEnvCache();
      expect([...turnstileHostnames()]).toEqual(["book.bigthinkcapital.com"]);
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: true, action: "book", hostname: "localhost" }) })).toEqual({
        ok: false,
        reason: "hostname_mismatch",
      });
      vi.stubEnv("TURNSTILE_HOSTNAMES", "localhost");
      vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
      resetEnvCache();
      expect(turnstileHostnames().size).toBe(0);
      expect(await verifyTurnstile("token", { action: "book", fetchImpl: cf({ success: true, action: "book", hostname: "localhost" }) })).toEqual({
        ok: false,
        reason: "no_hostnames",
      });
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  });
});
