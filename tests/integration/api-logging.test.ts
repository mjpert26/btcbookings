import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";

/**
 * Error and request logging must never hold up or change a response. `after` from next/server
 * is replaced so a test can either run callbacks later, as Next.js does after the response is
 * sent, or throw as it does outside a request.
 */
const afterMode = vi.hoisted(() => ({ defer: false, pending: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      if (!afterMode.defer) throw new Error("`after` was called outside a request scope");
      afterMode.pending.push(fn);
    },
  };
});

const { apiRoute } = await import("@/server/api/http");
const { createApiKey } = await import("@/server/oauth/server");
const { logError, LOG_WRITE_LIMITS } = await import("@/server/errors/log");
const { reportMcpError } = await import("@/server/mcp/report");
const { GET: meGET } = await import("@/app/api/v1/me/route");

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  afterMode.defer = false;
  afterMode.pending = [];
});

async function runPending(): Promise<void> {
  const fns = afterMode.pending.splice(0);
  for (const fn of fns) await fn();
}

/** Holds an exclusive lock on a table until the returned release function is called. */
async function lockTable(table: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = sql.begin(async (tx) => {
    await tx.unsafe(`lock table ${table} in exclusive mode`);
    locked();
    await gate;
  });
  await isLocked;
  return {
    release: async () => {
      open();
      await holder;
    },
  };
}

function apiReq(path: string, key?: string): Request {
  return new Request(`http://localhost:3000${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
}

const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
};

describe("error log writes", () => {
  it("send the REST API 500 before the error is logged", async () => {
    afterMode.defer = true;
    const u = await makeUser(sql);
    const { key } = await createApiKey(u.id, "k");
    const handler = apiRoute(async () => {
      throw new Error("boom");
    });
    const lock = await lockTable("app.error_log");
    const started = Date.now();
    let took = 0;
    let res: Response;
    try {
      res = await handler(apiReq("/api/v1/broken", key), {} as never);
    } finally {
      // The response is already complete while the error log is still locked.
      took = Date.now() - started;
      await lock.release();
    }
    expect(res.status).toBe(500);
    expect(took).toBeLessThan(1000);
    expect(await sql`select 1 from app.error_log`).toHaveLength(0);
    await runPending();
    const rows = await sql`select source, route, message from app.error_log`;
    expect(rows).toEqual([{ source: "api", route: "/api/v1/broken", message: "boom" }]);
  });

  it("report MCP tool errors after the response", async () => {
    afterMode.defer = true;
    const lock = await lockTable("app.error_log");
    const started = Date.now();
    let took = 0;
    try {
      await reportMcpError(new Error("tool failed"), "list_bookings");
    } finally {
      took = Date.now() - started;
      await lock.release();
    }
    expect(took).toBeLessThan(1000);
    await runPending();
    const [row] = await sql`select source, context from app.error_log`;
    expect(row).toEqual({ source: "mcp", context: { tool: "list_bookings" } });
  });

  it("give up after the lock timeout instead of waiting for the database", async () => {
    const restore = quiet();
    const lock = await lockTable("app.error_log");
    const started = Date.now();
    let took = 0;
    try {
      await expect(logError(new Error("slow"), { source: "api" })).resolves.toBeUndefined();
    } finally {
      took = Date.now() - started;
      await lock.release();
      restore();
    }
    expect(took).toBeGreaterThanOrEqual(LOG_WRITE_LIMITS.lockTimeoutMs - 100);
    expect(took).toBeLessThan(LOG_WRITE_LIMITS.overallMs);
    expect(await sql`select 1 from app.error_log`).toHaveLength(0);
  });
});

describe("request log writes", () => {
  it("never change the response, even when the insert fails or is slow", async () => {
    const u = await makeUser(sql);
    const { key } = await createApiKey(u.id, "k");

    // Outside a request the insert runs before returning; a failing insert is swallowed.
    await sql.unsafe("alter table app.api_request_log add constraint test_reject check (false) not valid");
    const restore = quiet();
    try {
      const res = await meGET(apiReq("/api/v1/me", key), {} as never);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { id: string } }).data.id).toBe(u.id);
    } finally {
      restore();
      await sql.unsafe("alter table app.api_request_log drop constraint test_reject");
    }
    expect(await sql`select 1 from app.api_request_log`).toHaveLength(0);

    // In a request the insert runs after the response, so a locked table does not delay it.
    afterMode.defer = true;
    const lock = await lockTable("app.api_request_log");
    const started = Date.now();
    let took = 0;
    try {
      expect((await meGET(apiReq("/api/v1/me", key), {} as never)).status).toBe(200);
    } finally {
      took = Date.now() - started;
      await lock.release();
    }
    expect(took).toBeLessThan(1000);
    await runPending();
    expect(await sql`select status from app.api_request_log`).toEqual([{ status: 200 }]);
  });

  it("skip unauthenticated requests", async () => {
    expect((await meGET(apiReq("/api/v1/me"), {} as never)).status).toBe(401);
    expect((await meGET(apiReq("/api/v1/me", "btc_pat_not-a-real-key"), {} as never)).status).toBe(401);
    expect(afterMode.pending).toHaveLength(0);
    expect(await sql`select 1 from app.api_request_log`).toHaveLength(0);
  });
});
