import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { rateLimit } from "@/server/http/rate-limit";
import { verifyTurnstile } from "@/server/http/turnstile";

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
  it("skips verification outside production when unconfigured", async () => {
    expect(await verifyTurnstile(null)).toEqual({ ok: true });
  });
});
