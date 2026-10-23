import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost } from "../helpers/booking-flow-fixtures";
import type { Sql } from "@/server/db/client";
import { createBooking } from "@/server/booking/create";
import { createApiKey, createAuthCode, registerClient, validateAuthorizeRequest, OAuthError } from "@/server/oauth/server";
import { POST as tokenPOST } from "@/app/api/oauth/token/route";
import { POST as registerPOST } from "@/app/api/oauth/register/route";
import { POST as revokePOST } from "@/app/api/oauth/revoke/route";
import { POST as mcpPOST } from "@/app/api/mcp/route";
import { GET as meGET } from "@/app/api/v1/me/route";
import { GET as bookingsGET, POST as bookingsPOST } from "@/app/api/v1/bookings/route";
import { GET as eventTypesGET, POST as eventTypesPOST } from "@/app/api/v1/event-types/route";
import { PATCH as eventTypePATCH } from "@/app/api/v1/event-types/[id]/route";
import { POST as questionsPOST } from "@/app/api/v1/event-types/[id]/questions/route";
import { DELETE as questionDELETE } from "@/app/api/v1/event-types/[id]/questions/[key]/route";
import { POST as usersPOST } from "@/app/api/v1/users/route";
import { GET as openapiGET } from "@/app/api/v1/openapi.json/route";
import { GET as protectedResourceGET } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import { GET as asMetadataGET } from "@/app/.well-known/oauth-authorization-server/route";
import { isAllowedRedirect, matchesPattern } from "@/lib/oauth-redirects";
import { rpcMethodsOf } from "@/server/api/request-log";
import { withUser } from "@/server/db/client";

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb(10);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  // truncateAll empties every app table, including the seeded callback allowlist.
  await sql`insert into app.oauth_redirect_allowlist (pattern) values ('https://claude.ai/api/mcp/auth_callback'), ('http://localhost:*/callback')`;
});

const BASE = "http://localhost:3000";
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) }) as never;

function req(path: string, init: RequestInit & { token?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, { ...init, headers });
}

function pkce() {
  const verifier = "v".repeat(20) + Math.random().toString(36).slice(2) + "x".repeat(20);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function oauthTokens(userId: string) {
  const client = await registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: `${BASE}/mcp`,
  });
  const authReq = await validateAuthorizeRequest(params);
  const code = await createAuthCode(authReq, userId);
  const res = await tokenPOST(
    req("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }).toString(),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { ...body, clientId: client.client_id, verifier, code };
}

async function rpc(token: string | undefined, method: string, params: Record<string, unknown> = {}, id: number | "notification" = 1) {
  const res = await mcpPOST(req("/mcp", { method: "POST", token, body: JSON.stringify({ jsonrpc: "2.0", ...(id === "notification" ? {} : { id }), method, params }) }));
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : ((await res.json()) as Record<string, unknown>) };
}

describe("callback URL rules", () => {
  it("matches exact URLs and loopback port wildcards only", () => {
    expect(matchesPattern("http://localhost:53211/callback", "http://localhost:*/callback")).toBe(true);
    expect(matchesPattern("http://localhost/callback", "http://localhost:*/callback")).toBe(false);
    expect(matchesPattern("http://localhost:1/other", "http://localhost:*/callback")).toBe(false);
    expect(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback", ["https://claude.ai/api/mcp/auth_callback"])).toBe(true);
    expect(isAllowedRedirect("https://evil.example/cb", ["https://claude.ai/api/mcp/auth_callback"])).toBe(false);
    expect(isAllowedRedirect("http://evil.example/cb", ["http://evil.example/cb"])).toBe(false);
  });
});

describe("OAuth authorization server", () => {
  it("publishes metadata for the MCP resource and the authorization server", async () => {
    const pr = (await (await protectedResourceGET(req("/.well-known/oauth-protected-resource"))).json()) as Record<string, unknown>;
    expect(pr).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = (await (await asMetadataGET()).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ["S256"], registration_endpoint: `${BASE}/api/oauth/register` });
  });

  it("registers clients only with allowlisted callback URLs", async () => {
    const bad = await registerPOST(req("/api/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "X", redirect_uris: ["https://evil.example/cb"] }) }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    const good = await registerPOST(req("/api/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] }) }));
    expect(good.status).toBe(201);
    expect(((await good.json()) as { client_id: string }).client_id).toMatch(/^btc_/);
  });

  it("issues tokens for a valid code once, enforces PKCE, rotates refresh tokens and detects reuse", async () => {
    const user = await makeUser(sql);
    const t = await oauthTokens(user.id);
    expect(t.access_token).toMatch(/^btc_at_/);
    expect(t.expires_in).toBe(3600);

    // The code is single use.
    const again = await tokenPOST(
      req("/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: t.code, client_id: t.clientId, code_verifier: t.verifier }).toString(),
      }),
    );
    expect(again.status).toBe(400);

    const refresh = async (rt: string) =>
      tokenPOST(
        req("/api/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: t.clientId }).toString(),
        }),
      );
    const r1 = await refresh(t.refresh_token);
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as { access_token: string; refresh_token: string };
    // Presenting the rotated token again revokes the family, including the newest tokens.
    expect((await refresh(t.refresh_token)).status).toBe(400);
    expect((await rpc(next.access_token, "ping")).status).toBe(401);
    expect((await refresh(next.refresh_token)).status).toBe(400);
  });

  it("rejects an authorization request with a wrong PKCE verifier or an unregistered callback", async () => {
    const user = await makeUser(sql);
    const client = await registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    await expect(
      validateAuthorizeRequest(new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://claude.ai/other", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" })),
    ).rejects.toBeInstanceOf(OAuthError);
    const { challenge } = pkce();
    const authReq = await validateAuthorizeRequest(
      new URLSearchParams({ client_id: client.client_id, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const code = await createAuthCode(authReq, user.id);
    const res = await tokenPOST(
      req("/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, code_verifier: "w".repeat(50) }).toString(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("revokes tokens", async () => {
    const user = await makeUser(sql);
    const t = await oauthTokens(user.id);
    expect((await rpc(t.access_token, "ping")).status).toBe(200);
    await revokePOST(req("/api/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${t.refresh_token}` }));
    expect((await rpc(t.access_token, "ping")).status).toBe(401);
  });
});

describe("MCP server", () => {
  it("asks for authorization with resource metadata", async () => {
    const r = await rpc(undefined, "initialize", { protocolVersion: "2025-06-18" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  });

  it("initializes, lists role-filtered tools and runs tools as the user", async () => {
    const agent = await makeHost(sql, { name: "Agent A" });
    const admin = await makeUser(sql, { role: "admin", name: "Admin" });
    const agentTok = (await oauthTokens(agent.id)).access_token;
    const adminTok = (await oauthTokens(admin.id)).access_token;

    const init = await rpc(agentTok, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "btc-scheduler" } } });
    expect((await rpc(agentTok, "notifications/initialized", {}, "notification")).status).toBe(202);

    const agentTools = ((await rpc(agentTok, "tools/list")).body as { result: { tools: { name: string; inputSchema: { type: string } }[] } }).result.tools;
    const adminTools = ((await rpc(adminTok, "tools/list")).body as { result: { tools: { name: string }[] } }).result.tools;
    expect(agentTools.map((t) => t.name)).toContain("schedule_meeting");
    expect(agentTools.map((t) => t.name)).not.toContain("create_user");
    expect(adminTools.map((t) => t.name)).toContain("create_user");
    expect(agentTools.every((t) => t.inputSchema.type === "object")).toBe(true);

    const who = (await rpc(agentTok, "tools/call", { name: "whoami", arguments: {} })).body as { result: { structuredContent: { role: string; roleLabel: string }; isError: boolean } };
    expect(who.result).toMatchObject({ isError: false, structuredContent: { role: "user", roleLabel: "Agent" } });

    const denied = (await rpc(agentTok, "tools/call", { name: "create_user", arguments: { email: "x@bigthinkcapital.com", name: "X" } })).body as { result: { isError: boolean } };
    expect(denied.result.isError).toBe(true);
    expect(await sql`select 1 from app.users where email = 'x@bigthinkcapital.com'`).toHaveLength(0);

    const created = (await rpc(adminTok, "tools/call", { name: "create_user", arguments: { email: "new.rep@bigthinkcapital.com", name: "New Rep" } })).body as { result: { isError: boolean } };
    expect(created.result.isError).toBe(false);
    const [audit] = await sql<{ via: string }[]>`select via from app.audit_log where action = 'user.create'`;
    expect(audit.via).toBe("mcp");
  });

  it("schedules a meeting through MCP and scopes bookings to the agent", async () => {
    const a = await makeHost(sql, { name: "Agent A" });
    const b = await makeHost(sql, { name: "Agent B" });
    const evA = await makeEvent(sql, { userId: a.id });
    const evB = await makeEvent(sql, { userId: b.id });
    await createBooking({ owner: { kind: "user", slug: b.slug }, eventSlug: evB.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee() });
    const tok = (await oauthTokens(a.id)).access_token;

    const start = futureSlot(2);
    const slots = (await rpc(tok, "tools/call", { name: "find_available_times", arguments: { eventTypeId: evA.id, from: futureSlot(2, 0), to: futureSlot(3, 0) } })).body as {
      result: { structuredContent: { result: { start: string }[] } };
    };
    expect(slots.result.structuredContent.result.some((s) => Date.parse(s.start) === Date.parse(start))).toBe(true);

    const booked = (await rpc(tok, "tools/call", {
      name: "schedule_meeting",
      arguments: { eventTypeId: evA.id, start, invitee: { name: "Merchant", email: "merchant@example.com", timezone: "America/New_York" } },
    })).body as { result: { isError: boolean; structuredContent: { id: string; createdVia: string } } };
    expect(booked.result.isError).toBe(false);
    expect(booked.result.structuredContent.createdVia).toBe("mcp");

    const list = (await rpc(tok, "tools/call", { name: "list_bookings", arguments: {} })).body as { result: { structuredContent: { result: { id: string }[] } } };
    expect(list.result.structuredContent.result.map((x) => x.id)).toEqual([booked.result.structuredContent.id]);
  });
});

describe("REST API", () => {
  it("authenticates API keys and enforces roles", async () => {
    expect((await meGET(req("/api/v1/me"), ctx({}))).status).toBe(401);
    const agent = await makeHost(sql);
    const { key } = await createApiKey(agent.id, "test");
    const me = (await (await meGET(req("/api/v1/me", { token: key }), ctx({}))).json()) as { data: { role: string; capabilities: string[] } };
    expect(me.data.role).toBe("user");
    expect(me.data.capabilities).not.toContain("users.manage");

    const denied = await usersPOST(req("/api/v1/users", { method: "POST", token: key, body: JSON.stringify({ email: "a@bigthinkcapital.com", name: "A" }) }), ctx({}));
    expect(denied.status).toBe(403);

    // OAuth access tokens are for the MCP server, not the REST API.
    const oauth = (await oauthTokens(agent.id)).access_token;
    expect((await meGET(req("/api/v1/me", { token: oauth }), ctx({}))).status).toBe(401);
  });

  it("lets managers see all bookings while agents see their own", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const evA = await makeEvent(sql, { userId: a.id });
    const evB = await makeEvent(sql, { userId: b.id });
    await createBooking({ owner: { kind: "user", slug: a.slug }, eventSlug: evA.slug, language: "en", start: futureSlot(2), durationMin: 30, ...invitee() });
    await createBooking({ owner: { kind: "user", slug: b.slug }, eventSlug: evB.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee() });
    const manager = await makeUser(sql, { name: "Manager" });
    await sql`update app.users set role = 'manager' where id = ${manager.id}`;
    const keyA = (await createApiKey(a.id, "a")).key;
    const keyM = (await createApiKey(manager.id, "m")).key;
    const list = async (k: string) => ((await (await bookingsGET(req("/api/v1/bookings", { token: k }), ctx({}))).json()) as { data: unknown[] }).data;
    expect(await list(keyA)).toHaveLength(1);
    expect(await list(keyM)).toHaveLength(2);
  });

  it("creates and edits booking pages and questions, schedules a meeting, and audits field changes", async () => {
    const host = await makeHost(sql);
    const { key } = await createApiKey(host.id, "rest");
    const created = await eventTypesPOST(
      req("/api/v1/event-types", { method: "POST", token: key, body: JSON.stringify({ name: "Intro", slug: "intro", durations: [15, 30], isActive: true, minNoticeMin: 0 }) }),
      ctx({}),
    );
    expect(created.status).toBe(201);
    const page = ((await created.json()) as { data: { id: string; defaultDuration: number; url: string } }).data;
    expect(page.defaultDuration).toBe(15);
    expect(page.url).toContain("/intro");

    const patched = await eventTypePATCH(req(`/api/v1/event-types/${page.id}`, { method: "PATCH", token: key, body: JSON.stringify({ name: "Intro call", bufferAfterMin: 10 }) }), ctx({ id: page.id }));
    expect(patched.status).toBe(200);
    const [audit] = await sql<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select before, after from app.audit_log where action = 'event_type.update' and entity_id = ${page.id}`;
    expect(audit.after).toEqual({ name: "Intro call", bufferAfterMin: 10 });
    expect(audit.before).toEqual({ name: "Intro", bufferAfterMin: 0 });

    const q = await questionsPOST(
      req(`/api/v1/event-types/${page.id}/questions`, { method: "POST", token: key, body: JSON.stringify({ question: { key: "company", type: "text", label: { en: "Company" }, required: true } }) }),
      ctx({ id: page.id }),
    );
    expect(q.status).toBe(201);
    const booked = await bookingsPOST(
      req("/api/v1/bookings", {
        method: "POST",
        token: key,
        body: JSON.stringify({
          eventTypeId: page.id,
          start: futureSlot(2),
          invitee: { name: "M", email: "m@example.com", phone: "(212) 555-0142", smsConsent: true, timezone: "America/New_York" },
          answers: { company: "Acme" },
        }),
      }),
      ctx({}),
    );
    expect(booked.status).toBe(201);
    const bookedData = ((await booked.json()) as { data: { id: string; createdVia: string } }).data;
    expect(bookedData.createdVia).toBe("api");
    // The caller confirmed the invitee agreed to reminder texts.
    const [consent] = await sql<{ sms_consent_at: Date | null }[]>`select sms_consent_at from app.bookings where id = ${bookedData.id}`;
    expect(consent.sms_consent_at).toBeInstanceOf(Date);

    const removed = await questionDELETE(req(`/api/v1/event-types/${page.id}/questions/company`, { method: "DELETE", token: key }), ctx({ id: page.id, key: "company" }));
    expect(((await removed.json()) as { data: unknown[] }).data).toEqual([]);

    const pages = ((await (await eventTypesGET(req("/api/v1/event-types?mine=true", { token: key }), ctx({}))).json()) as { data: { id: string }[] }).data;
    expect(pages.map((p) => p.id)).toEqual([page.id]);
  });

  it("serves a valid OpenAPI document", async () => {
    const doc = (await (await openapiGET()).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/bookings");
  });
});

describe("request log", () => {
  it("names JSON-RPC methods and tools", () => {
    expect(rpcMethodsOf({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_bookings" } })).toEqual(["tools/call list_bookings"]);
    expect(rpcMethodsOf([{ method: "initialize" }, { method: "notifications/initialized" }, "junk", null])).toEqual(["initialize", "notifications/initialized"]);
    expect(rpcMethodsOf({ method: "tools/call", params: { name: "x<script>" } })).toEqual(["tools/call xscript"]);
  });

  it("records authenticated API and MCP requests without bodies and scopes them by user", async () => {
    const agent = await makeHost(sql, { name: "Agent A" });
    const admin = await makeUser(sql, { role: "admin", name: "Admin" });
    const { key } = await createApiKey(agent.id, "logged");
    const tok = (await oauthTokens(admin.id)).access_token;

    expect((await meGET(req("/api/v1/me"), ctx({}))).status).toBe(401);
    expect((await meGET(req("/api/v1/me?secret=abc", { token: key }), ctx({}))).status).toBe(200);
    await rpc(tok, "tools/call", { name: "whoami", arguments: {} });

    const rows = await sql<{ via: string; user_id: string; method: string; route: string; rpc_methods: string[]; status: number; client_id: string | null }[]>`
      select via, user_id, method, route, rpc_methods, status, client_id from app.api_request_log order by id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ via: "api", user_id: agent.id, method: "GET", route: "/api/v1/me", rpc_methods: [], status: 200 });
    expect(rows[1]).toMatchObject({ via: "mcp", user_id: admin.id, method: "POST", rpc_methods: ["tools/call whoami"], status: 200 });
    expect(rows[1].client_id).not.toBeNull();

    const seenByAgent = await withUser(agent.id, (tx) => tx`select user_id from app.api_request_log`);
    const seenByAdmin = await withUser(admin.id, (tx) => tx`select user_id from app.api_request_log`);
    expect(seenByAgent.map((r) => r.user_id)).toEqual([agent.id]);
    expect(seenByAdmin).toHaveLength(2);
    await expect(withUser(agent.id, (tx) => tx`delete from app.api_request_log`)).rejects.toMatchObject({ code: "42501" });
  });
});
