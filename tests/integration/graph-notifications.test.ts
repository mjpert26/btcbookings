import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { sha256Hex } from "@/server/crypto/random";
import { POST as notify } from "@/app/api/graph/notifications/route";
import { POST as lifecycle } from "@/app/api/graph/lifecycle/route";

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

const STATE = "correct-client-state-0123456789abcdefghijklm";

async function subscribedUser(subscriptionId: string, status: "healthy" | "broken" = "healthy") {
  const u = await makeUser(sql, { calendar: status });
  await sql`
    update app.calendar_connections set subscription_id = ${subscriptionId}, client_state_hash = ${sha256Hex(STATE)},
      subscription_expires_at = now() + interval '5 days'
    where user_id = ${u.id}
  `;
  return u;
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const change = (subscriptionId: string, clientState: string) => ({
  subscriptionId,
  clientState,
  changeType: "updated",
  resource: "Users/x/Events/y",
  tenantId: "t",
});

describe("validation handshake", () => {
  it("echoes the URL-decoded validationToken as text/plain on both endpoints", async () => {
    const token = "Validation: Token <with> spaces & symbols";
    for (const [handler, path] of [
      [notify, "/api/graph/notifications"],
      [lifecycle, "/api/graph/lifecycle"],
    ] as const) {
      const req = new Request(`http://localhost:3000${path}?validationToken=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
      const res = await handler(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await res.text()).toBe(token);
    }
  });
});

describe("change notifications", () => {
  it("verifies clientState and enqueues one bucketed delta sync per user", async () => {
    const u = await subscribedUser("sub-1");
    const res = await notify(post("/api/graph/notifications", { value: [change("sub-1", STATE), change("sub-1", STATE)] }));
    expect(res.status).toBe(202);
    await notify(post("/api/graph/notifications", { value: [change("sub-1", STATE)] }));

    const jobs = await sql`select payload, idempotency_key, run_at from app.jobs where kind = 'graph_delta_sync'`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ userId: u.id });
    expect(jobs[0].idempotency_key).toMatch(new RegExp(`^delta:${u.id}:\\d+$`));
    const bucket = Number(jobs[0].idempotency_key.split(":").pop());
    expect(jobs[0].run_at.getTime()).toBe((bucket + 1) * 30_000);
  });

  it("drops a wrong clientState and unknown subscriptions with an identical response", async () => {
    await subscribedUser("sub-1");
    const wrong = await notify(post("/api/graph/notifications", { value: [change("sub-1", "wrong-state")] }));
    const unknown = await notify(post("/api/graph/notifications", { value: [change("sub-unknown", STATE)] }));
    const missing = await notify(post("/api/graph/notifications", { value: [{ subscriptionId: "sub-1" }] }));
    for (const res of [wrong, unknown, missing]) {
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    }
    expect(await sql`select 1 from app.jobs`).toHaveLength(0);
  });

  it("checks each item separately, so a valid item does not vouch for a forged one", async () => {
    const a = await subscribedUser("sub-a");
    await subscribedUser("sub-b");
    await notify(post("/api/graph/notifications", { value: [change("sub-a", STATE), change("sub-b", "forged")] }));
    const jobs = await sql`select payload->>'userId' as user_id from app.jobs`;
    expect(jobs.map((j) => j.user_id)).toEqual([a.id]);
  });

  it("ignores notifications for broken connections", async () => {
    await subscribedUser("sub-1", "broken");
    expect((await notify(post("/api/graph/notifications", { value: [change("sub-1", STATE)] }))).status).toBe(202);
    expect(await sql`select 1 from app.jobs`).toHaveLength(0);
  });

  it("rejects malformed bodies", async () => {
    expect((await notify(post("/api/graph/notifications", "not json"))).status).toBe(400);
    expect((await notify(post("/api/graph/notifications", { value: "x" }))).status).toBe(400);
  });
});

describe("lifecycle notifications", () => {
  const event = (subscriptionId: string, lifecycleEvent: string, clientState = STATE) => ({
    subscriptionId,
    clientState,
    lifecycleEvent,
    subscriptionExpirationDateTime: new Date().toISOString(),
    tenantId: "t",
  });

  it("reauthorizationRequired marks the subscription due and enqueues an ensure job", async () => {
    const u = await subscribedUser("sub-1");
    const res = await lifecycle(post("/api/graph/lifecycle", { value: [event("sub-1", "reauthorizationRequired")] }));
    expect(res.status).toBe(202);
    const [cc] = await sql`select subscription_id, subscription_expires_at from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.subscription_id).toBe("sub-1");
    expect(cc.subscription_expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const jobs = await sql`select kind, payload from app.jobs`;
    expect(jobs).toEqual([{ kind: "graph_subscription_ensure", payload: { userId: u.id } }]);
  });

  it("subscriptionRemoved clears the subscription so the ensure job recreates it", async () => {
    const u = await subscribedUser("sub-1");
    await lifecycle(post("/api/graph/lifecycle", { value: [event("sub-1", "subscriptionRemoved")] }));
    const [cc] = await sql`select subscription_id, client_state_hash from app.calendar_connections where user_id = ${u.id}`;
    expect(cc).toEqual({ subscription_id: null, client_state_hash: null });
    expect((await sql`select kind from app.jobs`).map((j) => j.kind)).toEqual(["graph_subscription_ensure"]);
  });

  it("missed enqueues a delta sync", async () => {
    await subscribedUser("sub-1");
    await lifecycle(post("/api/graph/lifecycle", { value: [event("sub-1", "missed")] }));
    expect((await sql`select kind from app.jobs`).map((j) => j.kind)).toEqual(["graph_delta_sync"]);
  });

  it("ignores lifecycle events with a wrong clientState", async () => {
    const u = await subscribedUser("sub-1");
    const res = await lifecycle(post("/api/graph/lifecycle", { value: [event("sub-1", "subscriptionRemoved", "forged")] }));
    expect(res.status).toBe(202);
    const [cc] = await sql`select subscription_id from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.subscription_id).toBe("sub-1");
    expect(await sql`select 1 from app.jobs`).toHaveLength(0);
  });
});
