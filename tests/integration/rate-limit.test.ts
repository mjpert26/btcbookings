import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { rateLimit } from "@/server/http/rate-limit";
import { verifyTurnstile } from "@/server/http/turnstile";
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
  it("skips verification when unconfigured, in every environment", async () => {
    expect(await verifyTurnstile(null)).toEqual({ ok: true });
    const prev = { node: process.env.NODE_ENV };
    vi.stubEnv("NODE_ENV", "production");
    try {
      resetEnvCache();
      expect(await verifyTurnstile(null)).toEqual({ ok: true });
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
    expect(process.env.NODE_ENV).toBe(prev.node);
  });

  it("verifies tokens with Cloudflare once a secret is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    try {
      resetEnvCache();
      expect(await verifyTurnstile(null)).toEqual({ ok: false, reason: "missing_token" });
      const fakeFetch = (async () => new Response(JSON.stringify({ success: true }))) as typeof fetch;
      expect(await verifyTurnstile("token", undefined, fakeFetch)).toEqual({ ok: true });
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  });
});
