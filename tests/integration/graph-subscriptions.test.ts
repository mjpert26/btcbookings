import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { graphError, installGraphMock, json, resetGraph, type GraphMock } from "../helpers/graph-mock";
import type { Sql } from "@/server/db/client";
import { sha256Hex } from "@/server/crypto/random";
import {
  deleteSubscription,
  ensureMissing,
  ensureSubscription,
  MAX_LIFETIME_MINUTES,
  renewExpiring,
} from "@/server/graph/subscriptions";
import { GET as subscriptionsCron } from "@/app/api/cron/graph-subscriptions/route";
import { GET as deltaCron } from "@/app/api/cron/graph-delta/route";
import { completeLogin } from "@/server/auth/login";

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

const subResponse = (call: { body: unknown }, id = "sub-new") =>
  json(201, { id, expirationDateTime: (call.body as { expirationDateTime: string }).expirationDateTime, resource: "me/events" });

describe("ensureSubscription", () => {
  it("creates a subscription with a random clientState stored only as a hash", async () => {
    const u = await makeUser(sql);
    mock.on("POST", /\/subscriptions$/, (call) => subResponse(call));
    expect(await ensureSubscription(u.id)).toBe("created");

    const body = mock.callsTo("POST", /\/subscriptions$/)[0].body as Record<string, string>;
    expect(body).toMatchObject({
      changeType: "created,updated,deleted",
      resource: "me/events",
      notificationUrl: "http://localhost:3000/api/graph/notifications",
      lifecycleNotificationUrl: "http://localhost:3000/api/graph/lifecycle",
    });
    expect(body.clientState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetimeMin = (Date.parse(body.expirationDateTime) - Date.now()) / 60_000;
    expect(lifetimeMin).toBeLessThanOrEqual(MAX_LIFETIME_MINUTES);
    expect(lifetimeMin).toBeGreaterThan(MAX_LIFETIME_MINUTES - 60);

    const [cc] = await sql`select * from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.subscription_id).toBe("sub-new");
    expect(cc.client_state_hash).toBe(sha256Hex(body.clientState));
    expect(JSON.stringify(cc)).not.toContain(body.clientState);
    // A delta sync is queued to catch changes made before the subscription existed.
    expect(await sql`select 1 from app.jobs where kind = 'graph_delta_sync'`).toHaveLength(1);
  });

  it("leaves a fresh subscription alone and renews one expiring within 48 hours", async () => {
    const u = await makeUser(sql);
    await sql`
      update app.calendar_connections set subscription_id = 'sub-1', client_state_hash = 'h',
        subscription_expires_at = now() + interval '5 days' where user_id = ${u.id}
    `;
    expect(await ensureSubscription(u.id)).toBe("unchanged");
    expect(mock.calls).toHaveLength(0);

    await sql`update app.calendar_connections set subscription_expires_at = now() + interval '30 hours' where user_id = ${u.id}`;
    mock.on("PATCH", /\/subscriptions\/sub-1$/, (call) => json(200, { id: "sub-1", ...(call.body as object) }));
    expect(await ensureSubscription(u.id)).toBe("renewed");
    const [cc] = await sql`select subscription_id, client_state_hash, subscription_expires_at from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.subscription_id).toBe("sub-1");
    expect(cc.client_state_hash).toBe("h");
    expect(cc.subscription_expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect(Object.keys(mock.calls[0].body as object)).toEqual(["expirationDateTime"]);
  });

  it("recreates the subscription when Graph no longer has it", async () => {
    const u = await makeUser(sql);
    await sql`update app.calendar_connections set subscription_id = 'gone', subscription_expires_at = now() where user_id = ${u.id}`;
    mock.on("PATCH", /\/subscriptions\/gone$/, graphError(404, "ResourceNotFound"));
    mock.on("POST", /\/subscriptions$/, (call) => subResponse(call, "sub-2"));
    expect(await ensureSubscription(u.id)).toBe("created");
    const [cc] = await sql`select subscription_id from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.subscription_id).toBe("sub-2");
  });

  it("clears a stale duplicate on 409 and creates again", async () => {
    const u = await makeUser(sql);
    mock.on("POST", /\/subscriptions$/, graphError(409, "ExtensionError"), (call) => subResponse(call, "sub-3"));
    mock.on("GET", /\/subscriptions$/, json(200, {
      value: [
        { id: "stale", resource: "me/events", notificationUrl: "http://localhost:3000/api/graph/notifications" },
        { id: "other-app", resource: "me/messages", notificationUrl: "https://elsewhere.example.com/hook" },
      ],
    }));
    mock.on("DELETE", /\/subscriptions\/stale$/, new Response(null, { status: 204 }));
    expect(await ensureSubscription(u.id)).toBe("created");
    expect(mock.callsTo("DELETE", /other-app/)).toHaveLength(0);
    expect(mock.callsTo("DELETE", /stale/)).toHaveLength(1);
  });

  it("deletes the subscription on disconnect, treating 404 as done", async () => {
    const u = await makeUser(sql);
    await sql`update app.calendar_connections set subscription_id = 'sub-x', client_state_hash = 'h' where user_id = ${u.id}`;
    mock.on("DELETE", /\/subscriptions\/sub-x$/, graphError(404, "ResourceNotFound"));
    await deleteSubscription(u.id);
    const [cc] = await sql`select subscription_id, client_state_hash from app.calendar_connections where user_id = ${u.id}`;
    expect(cc).toEqual({ subscription_id: null, client_state_hash: null });
  });
});

describe("renewal and delta crons", () => {
  const cronReq = (path: string, secret = process.env.CRON_SECRET) =>
    new Request(`http://localhost:3000${path}`, { headers: { authorization: `Bearer ${secret}` } });

  it("rejects calls without the cron secret", async () => {
    expect((await subscriptionsCron(cronReq("/api/cron/graph-subscriptions", "wrong-secret-0000"))).status).toBe(401);
    expect((await deltaCron(cronReq("/api/cron/graph-delta", "wrong-secret-0000"))).status).toBe(401);
  });

  it("enqueues ensure jobs for expiring and missing subscriptions only", async () => {
    const expiring = await makeUser(sql);
    const fresh = await makeUser(sql);
    const missing = await makeUser(sql);
    const broken = await makeUser(sql, { calendar: "broken" });
    await sql`update app.calendar_connections set subscription_id = 'a', subscription_expires_at = now() + interval '1 day' where user_id = ${expiring.id}`;
    await sql`update app.calendar_connections set subscription_id = 'b', subscription_expires_at = now() + interval '6 days' where user_id = ${fresh.id}`;

    const res = await subscriptionsCron(cronReq("/api/cron/graph-subscriptions"));
    expect(await res.json()).toEqual({ renewing: 1, creating: 1 });
    const jobs = await sql`select payload->>'userId' as user_id from app.jobs where kind = 'graph_subscription_ensure'`;
    expect(jobs.map((j) => j.user_id).sort()).toEqual([expiring.id, missing.id].sort());
    expect(jobs.map((j) => j.user_id)).not.toContain(broken.id);

    // Same 6-hour bucket: no duplicates.
    expect(await renewExpiring()).toBe(1);
    expect(await ensureMissing()).toBe(1);
    expect(await sql`select 1 from app.jobs where kind = 'graph_subscription_ensure'`).toHaveLength(2);
  });

  it("enqueues one delta sync per healthy connection per bucket", async () => {
    await makeUser(sql);
    await makeUser(sql);
    await makeUser(sql, { calendar: "broken" });
    const res = await deltaCron(cronReq("/api/cron/graph-delta"));
    expect(await res.json()).toEqual({ enqueued: 2 });
    await deltaCron(cronReq("/api/cron/graph-delta"));
    expect(await sql`select 1 from app.jobs where kind = 'graph_delta_sync'`).toHaveLength(2);
  });
});

describe("sign-in", () => {
  it("enqueues graph_subscription_ensure inside the login transaction, once per day", async () => {
    const tokens = { accessToken: "a", refreshToken: "r", idToken: "i", expiresAt: new Date(Date.now() + 3600_000), scopes: [] };
    const claims = { oid: "oid-1", tid: "t", email: "login@bigthinkcapital.com", name: "Login User", preferredUsername: "login@bigthinkcapital.com" };
    const id = await completeLogin(claims, tokens);
    await completeLogin(claims, tokens);
    const jobs = await sql`select payload from app.jobs where kind = 'graph_subscription_ensure'`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ userId: id });
  });
});
