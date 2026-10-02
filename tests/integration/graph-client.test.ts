import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { graphError, installGraphMock, json, resetGraph, type GraphMock } from "../helpers/graph-mock";
import type { Sql } from "@/server/db/client";
import { graphClient, GraphError, GraphThrottledError } from "@/server/graph/client";
import { enqueue } from "@/server/jobs/queue";
import { runJobs } from "@/server/jobs/worker";
import { graphHandlers } from "@/server/graph/jobs";

let sql: Sql;
let mock: GraphMock;
beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  resetGraph();
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  mock = installGraphMock();
});
afterEach(() => resetGraph());

const USER = "00000000-0000-4000-8000-0000000000aa";

describe("graph client", () => {
  it("retries 429 honoring Retry-After, then succeeds", async () => {
    mock.on("GET", /\/me$/, graphError(429, "TooManyRequests", { "retry-after": "2" }), json(200, { id: "me" }));
    const res = await graphClient(USER).get<{ id: string }>("/me");
    expect(res.data.id).toBe("me");
    expect(mock.sleeps).toEqual([2000]);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].headers.authorization).toBe("Bearer token-1");
  });

  it("retries 503 and 504 with bounded attempts and then throws a throttled error", async () => {
    mock.on("GET", /\/me$/, graphError(503, "ServiceUnavailable"), graphError(504, "GatewayTimeout"));
    const err = await graphClient(USER).get("/me").catch((e) => e);
    expect(err).toBeInstanceOf(GraphThrottledError);
    expect(mock.calls).toHaveLength(4); // 1 + 3 retries
  });

  it("does not sleep for a Retry-After beyond the inline limit", async () => {
    mock.on("GET", /\/me$/, graphError(429, "TooManyRequests", { "retry-after": "120" }));
    const err = (await graphClient(USER).get("/me").catch((e) => e)) as GraphThrottledError;
    expect(err).toBeInstanceOf(GraphThrottledError);
    expect(err.retryAfterSeconds).toBe(120);
    expect(mock.sleeps).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });

  it("forces one token refresh on 401 and retries once", async () => {
    mock.on("GET", /\/me$/, graphError(401, "InvalidAuthenticationToken"), json(200, { id: "me" }));
    await graphClient(USER).get("/me");
    expect(mock.tokenRequests).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    expect(mock.calls[1].headers.authorization).toBe("Bearer token-2");

    mock = installGraphMock();
    mock.on("GET", /\/me$/, graphError(401, "InvalidAuthenticationToken"));
    const err = (await graphClient(USER).get("/me").catch((e) => e)) as GraphError;
    expect(err).toBeInstanceOf(GraphError);
    expect(err.status).toBe(401);
    expect(mock.calls).toHaveLength(2);
    expect(err.message).not.toContain("token-");
  });

  it("refuses to send the token to a non-Graph host", async () => {
    await expect(graphClient(USER).get("https://evil.example.com/v1.0/me")).rejects.toThrow(/non-Graph/);
    expect(mock.calls).toHaveLength(0);
  });

  it("maps a long Retry-After to a rescheduled job instead of a failure", async () => {
    const u = await makeUser(sql);
    await sql`update app.calendar_connections set subscription_id = 'sub-1', subscription_expires_at = now() where user_id = ${u.id}`;
    mock.on("PATCH", /\/subscriptions\/sub-1$/, graphError(429, "TooManyRequests", { "retry-after": "300" }));
    await enqueue(sql, { kind: "graph_subscription_ensure", payload: { userId: u.id }, idempotencyKey: "t1" });
    const report = await runJobs(graphHandlers, { sql, deadlineMs: 5000 });
    expect(report.retried).toBe(1);
    const [job] = await sql`select status, extract(epoch from (run_at - now())) as delay from app.jobs where idempotency_key = 't1'`;
    expect(job.status).toBe("failed");
    expect(Number(job.delay)).toBeGreaterThan(290);
  });
});
