import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import { serviceTx, withUser, type Sql } from "@/server/db/client";
import { createBooking } from "@/server/booking/create";
import { cancelByInvitee, rescheduleByInvitee } from "@/server/booking/manage";
import { cancelBookingAsHost } from "@/server/booking/host-actions";
import { reassignBooking } from "@/server/booking/jobs";
import { applyConflictPolicy } from "@/server/graph/delta";
import { loadAuditPage, loadBookingHistory, AuditForbiddenError } from "@/server/audit-log";
import { createApiKey, createAuthCode, registerClient, validateAuthorizeRequest } from "@/server/oauth/server";
import { POST as tokenPOST } from "@/app/api/oauth/token/route";
import { POST as mcpPOST } from "@/app/api/mcp/route";
import { GET as bookingsGET, POST as bookingsPOST } from "@/app/api/v1/bookings/route";
import { GET as bookingGET } from "@/app/api/v1/bookings/[id]/route";
import { POST as cancelPOST } from "@/app/api/v1/bookings/[id]/cancel/route";
import { POST as reschedulePOST } from "@/app/api/v1/bookings/[id]/reschedule/route";
import type { BookingInput } from "@/server/booking/types";

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb(10);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  await sql`insert into app.oauth_redirect_allowlist (pattern) values ('https://claude.ai/api/mcp/auth_callback')`;
});

const BASE = "http://localhost:3000";
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) }) as never;

function req(path: string, init: RequestInit & { token?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, { ...init, headers });
}

async function mcpToken(userId: string): Promise<string> {
  const client = await registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  const verifier = "v".repeat(20) + Math.random().toString(36).slice(2) + "x".repeat(20);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authReq = await validateAuthorizeRequest(
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
      resource: `${BASE}/mcp`,
    }),
  );
  const code = await createAuthCode(authReq, userId);
  const res = await tokenPOST(
    req("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }).toString(),
    }),
  );
  return ((await res.json()) as { access_token: string }).access_token;
}

type ToolResult = { isError: boolean; structuredContent: Record<string, unknown> };
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await mcpPOST(req("/mcp", { method: "POST", token, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return ((await res.json()) as { result: ToolResult }).result;
}

function input(owner: BookingInput["owner"], eventSlug: string, start: string): BookingInput {
  return { owner, eventSlug, language: "en", start, durationMin: 30, ...invitee() };
}

type AuditRow = { entity_id: string; action: string; actor_user_id: string | null; via: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
async function bookingAudits(bookingId?: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select entity_id, action, actor_user_id, via, before, after from app.audit_log
    where entity_type = 'booking' ${bookingId ? sql`and entity_id = ${bookingId}` : sql``}
    order by created_at, id
  `;
}

describe("booking history: exactly one entry per lifecycle event", () => {
  it("records public booking, invitee reschedule and invitee cancel as the invitee on the public channel", async () => {
    const host = await makeHost(sql, { name: "Hannah Host" });
    const ev = await makeEvent(sql, { userId: host.id });
    const r1 = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 15)));

    let all = await bookingAudits();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ entity_id: r1.bookingId, action: "booking.create", actor_user_id: null, via: "public", before: null });
    expect(all[0].after).toMatchObject({ status: "confirmed", eventTypeId: ev.id, durationMin: 30, hosts: ["Hannah Host"], hostUserIds: [host.id], createdVia: "public" });

    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(2, 17) });
    all = await bookingAudits();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ entity_id: r1.bookingId, action: "booking.reschedule", actor_user_id: null, via: "public" });
    expect(all[1].before).toMatchObject({ status: "confirmed", start: new Date(futureSlot(2, 15)).toISOString(), hosts: ["Hannah Host"] });
    expect(all[1].after).toMatchObject({ status: "rescheduled", newBookingId: r2.bookingId, start: new Date(futureSlot(2, 17)).toISOString() });

    await cancelByInvitee(r2.token, "Something came up");
    all = await bookingAudits();
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({
      entity_id: r2.bookingId,
      action: "booking.cancel",
      actor_user_id: null,
      via: "public",
      before: { status: "confirmed" },
      after: { status: "cancelled", cancelledBy: "invitee", reason: "Something came up" },
    });

    // Manage tokens and invitee contact details never reach the audit log.
    const text = JSON.stringify(await sql`select before, after from app.audit_log`);
    for (const secret of [r1.token, r2.token, "manage_token", "@example.com"]) expect(text).not.toContain(secret);

    // The new booking's timeline starts with the reschedule that created it.
    const history = await withUser(host.id, (tx) => loadBookingHistory(tx, r2.bookingId));
    expect(history.map((h) => [h.action, h.actorLabel, h.via])).toEqual([
      ["booking.reschedule", "Invitee", "public"],
      ["booking.cancel", "Invitee", "public"],
    ]);
    expect(history[0].rescheduledFromId).toBe(r1.bookingId);
    expect(history[1].changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "status", before: "confirmed", after: "cancelled" })]),
    );
  });

  it("records a host cancel from the web app once, with the host as actor", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const r = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(3, 15)));
    expect(await cancelBookingAsHost(host.id, r.bookingId, "Out sick")).toEqual({ ok: true, alreadyCancelled: false });
    expect(await cancelBookingAsHost(host.id, r.bookingId, "Out sick")).toEqual({ ok: true, alreadyCancelled: true });
    const cancels = (await bookingAudits(r.bookingId)).filter((a) => a.action === "booking.cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ actor_user_id: host.id, via: "web", after: { status: "cancelled", cancelledBy: "host", reason: "Out sick" } });
  });

  it("records REST create, reschedule and cancel once each, with the caller and channel api", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const { key } = await createApiKey(host.id, "rest");
    const created = await bookingsPOST(
      req("/api/v1/bookings", { method: "POST", token: key, body: JSON.stringify({ eventTypeId: ev.id, start: futureSlot(2, 14), invitee: invitee() }) }),
      ctx({}),
    );
    expect(created.status).toBe(201);
    const first = ((await created.json()) as { data: { id: string } }).data.id;
    expect(await bookingAudits()).toEqual([expect.objectContaining({ entity_id: first, action: "booking.create", actor_user_id: host.id, via: "api" })]);

    const moved = await reschedulePOST(req(`/api/v1/bookings/${first}/reschedule`, { method: "POST", token: key, body: JSON.stringify({ start: futureSlot(2, 16) }) }), ctx({ id: first }));
    expect(moved.status).toBe(200);
    const second = ((await moved.json()) as { data: { id: string } }).data.id;
    const cancelled = await cancelPOST(req(`/api/v1/bookings/${second}/cancel`, { method: "POST", token: key, body: JSON.stringify({ reason: "No longer needed" }) }), ctx({ id: second }));
    expect(cancelled.status).toBe(200);

    const all = await bookingAudits();
    expect(all.map((a) => [a.entity_id, a.action, a.actor_user_id, a.via])).toEqual([
      [first, "booking.create", host.id, "api"],
      [first, "booking.reschedule", host.id, "api"],
      [second, "booking.cancel", host.id, "api"],
    ]);
    expect(all[1].after).toMatchObject({ newBookingId: second });

    // The REST detail returns the history read under the caller's row-level security.
    const detail = ((await (await bookingGET(req(`/api/v1/bookings/${second}`, { token: key }), ctx({ id: second }))).json()) as { data: { history: { action: string; via: string }[] } }).data;
    expect(detail.history.map((h) => [h.action, h.via])).toEqual([
      ["booking.reschedule", "api"],
      ["booking.cancel", "api"],
    ]);
  });

  it("records MCP schedule and reschedule once each with channel mcp", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const tok = await mcpToken(host.id);
    const booked = await tool(tok, "schedule_meeting", { eventTypeId: ev.id, start: futureSlot(2, 14), invitee: invitee() });
    expect(booked.isError).toBe(false);
    const id = booked.structuredContent.id as string;
    const moved = await tool(tok, "reschedule_booking", { bookingId: id, start: futureSlot(2, 18) });
    expect(moved.isError).toBe(false);
    expect((await bookingAudits()).map((a) => [a.entity_id, a.action, a.actor_user_id, a.via])).toEqual([
      [id, "booking.create", host.id, "mcp"],
      [id, "booking.reschedule", host.id, "mcp"],
    ]);
  });

  it("records an MCP cancel once with channel mcp, and a repeat cancel records nothing", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const tok = await mcpToken(host.id);
    const booked = await tool(tok, "schedule_meeting", { eventTypeId: ev.id, start: futureSlot(2, 14), invitee: invitee() });
    expect(booked.isError).toBe(false);
    const id = booked.structuredContent.id as string;
    expect((await tool(tok, "cancel_booking", { bookingId: id, reason: "Merchant asked" })).isError).toBe(false);
    await tool(tok, "cancel_booking", { bookingId: id, reason: "Merchant asked" });
    const all = await bookingAudits();
    expect(all.map((a) => [a.entity_id, a.action, a.actor_user_id, a.via])).toEqual([
      [id, "booking.create", host.id, "mcp"],
      [id, "booking.cancel", host.id, "mcp"],
    ]);
    expect(all[1]).toMatchObject({ before: { status: "confirmed" }, after: { status: "cancelled", cancelledBy: "host", reason: "Merchant asked" } });
  });

  it("records Outlook conflict auto-cancel and flag as system", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const a = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 14)));
    const b = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 16)));

    await sql`update app.user_settings set outlook_conflict_policy = 'auto_cancel' where user_id = ${host.id}`;
    await serviceTx((tx) => applyConflictPolicy(tx, a.bookingId, host.id, "evt-a", "deleted"));
    await sql`update app.user_settings set outlook_conflict_policy = 'flag' where user_id = ${host.id}`;
    await serviceTx((tx) => applyConflictPolicy(tx, b.bookingId, host.id, "evt-b", "moved"));
    // A repeat on a booking that is no longer confirmed changes nothing and records nothing.
    await serviceTx((tx) => applyConflictPolicy(tx, b.bookingId, host.id, "evt-b", "moved"));

    const [ca] = (await bookingAudits(a.bookingId)).filter((x) => x.action !== "booking.create");
    expect(ca).toMatchObject({ action: "booking.cancel", actor_user_id: null, via: "system", after: { status: "cancelled", source: "outlook_conflict", conflict: "deleted" } });
    const flags = (await bookingAudits(b.bookingId)).filter((x) => x.action !== "booking.create");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ action: "booking.flag", actor_user_id: null, via: "system", after: { status: "flagged", source: "outlook_conflict", conflict: "moved" } });
  });

  it("records booking_reassign as a system host change, and a flag when nobody is free", async () => {
    const a = await makeHost(sql, { name: "Ana" });
    const b = await makeHost(sql, { name: "Ben" });
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id }, { minNotice: 0 });
    const ref = { kind: "team" as const, slug: team.slug };
    const r = await createBooking(input(ref, ev.slug, futureSlot(2, 13)));
    const [{ user_id: from }] = await sql<{ user_id: string }[]>`select user_id from app.booking_hosts where booking_id = ${r.bookingId} and active`;
    const to = from === a.id ? b.id : a.id;
    await sql`update app.team_members set status = 'paused' where user_id = ${from}`;
    expect(await reassignBooking({ bookingId: r.bookingId, fromUserId: from, reason: "removed_from_queue" })).toEqual({ result: { reassignedTo: to } });
    const [re] = (await bookingAudits(r.bookingId)).filter((x) => x.action === "booking.reassign");
    expect(re).toMatchObject({
      actor_user_id: null,
      via: "system",
      before: { hosts: [from === a.id ? "Ana" : "Ben"], hostUserId: from },
      after: { hosts: [from === a.id ? "Ben" : "Ana"], hostUserId: to, reason: "removed_from_queue" },
    });

    // The removed host loses the booking and its history; the new host gains both.
    expect(await withUser(from, (tx) => tx`select id from app.bookings where id = ${r.bookingId}`)).toHaveLength(0);
    expect(await withUser(from, (tx) => loadBookingHistory(tx, r.bookingId))).toEqual([]);
    expect(await withUser(to, (tx) => tx`select id from app.bookings where id = ${r.bookingId}`)).toHaveLength(1);
    expect((await withUser(to, (tx) => loadBookingHistory(tx, r.bookingId))).map((h) => h.action)).toEqual(["booking.create", "booking.reassign"]);

    // Both members busy at the same time: the second booking cannot move and is flagged.
    await sql`update app.team_members set status = 'active'`;
    const start = futureSlot(3, 13);
    const x = await createBooking(input(ref, ev.slug, start));
    await createBooking(input(ref, ev.slug, start));
    const [{ user_id: xHost }] = await sql<{ user_id: string }[]>`select user_id from app.booking_hosts where booking_id = ${x.bookingId} and active`;
    await sql`update app.team_members set status = 'paused' where user_id = ${xHost}`;
    expect(await reassignBooking({ bookingId: x.bookingId, fromUserId: xHost, reason: "paused" })).toEqual({ result: { flagged: "no eligible host is free" } });
    const xs = await bookingAudits(x.bookingId);
    expect(xs.map((e) => e.action)).toEqual(["booking.create", "booking.flag"]);
    expect(xs[1]).toMatchObject({ via: "system", after: { status: "flagged", source: "reassign" } });

    // The restored host keeps the booking, still in their name, and sees the flag.
    const [restored] = await sql<{ active: boolean; reassigned_at: Date | null }[]>`
      select active, reassigned_at from app.booking_hosts where booking_id = ${x.bookingId} and user_id = ${xHost}
    `;
    expect(restored).toEqual({ active: true, reassigned_at: null });
    expect(await withUser(xHost, (tx) => tx`select id from app.bookings where id = ${x.bookingId}`)).toHaveLength(1);
    expect((await withUser(xHost, (tx) => loadBookingHistory(tx, x.bookingId))).map((h) => h.action)).toEqual(["booking.create", "booking.flag"]);
  });

  it("writes no per-booking entries for imported Calendly bookings", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const r = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 9)));
    await sql`delete from app.audit_log`;
    await sql`update app.bookings set import_source = 'calendly', import_ref = 'cal-1' where id = ${r.bookingId}`;
    expect(await cancelBookingAsHost(host.id, r.bookingId, null)).toEqual({ ok: false, reason: "imported" });
    expect(await bookingAudits()).toHaveLength(0);
  });
});

describe("who can read bookings and their history", () => {
  async function scene() {
    const agentA = await makeHost(sql, { name: "Agent A" });
    const agentB = await makeHost(sql, { name: "Agent B" });
    const manager = await makeUser(sql, { role: "manager", name: "Manager" });
    const admin = await makeUser(sql, { role: "admin", name: "Admin" });
    const evB = await makeEvent(sql, { userId: agentB.id });
    const rB = await createBooking(input({ kind: "user", slug: agentB.slug }, evB.slug, futureSlot(2, 15)));
    return { agentA, agentB, manager, admin, bookingB: rB.bookingId, tokenB: rB.token };
  }

  it("agents cannot see or read another agent's booking or its history on any path", async () => {
    const { agentA, agentB, bookingB } = await scene();
    expect(await withUser(agentA.id, (tx) => tx`select id from app.bookings where id = ${bookingB}`)).toHaveLength(0);
    expect(await withUser(agentA.id, (tx) => tx`select id from app.audit_log where entity_id = ${bookingB}`)).toHaveLength(0);
    expect(await withUser(agentA.id, (tx) => loadBookingHistory(tx, bookingB))).toEqual([]);
    expect(await withUser(agentB.id, (tx) => loadBookingHistory(tx, bookingB))).toHaveLength(1);

    const { key } = await createApiKey(agentA.id, "a");
    expect((await bookingGET(req(`/api/v1/bookings/${bookingB}`, { token: key }), ctx({ id: bookingB }))).status).toBe(404);
    const listed = (await (await bookingsGET(req("/api/v1/bookings", { token: key }), ctx({}))).json()) as { data: unknown[] };
    expect(listed.data).toEqual([]);

    const tok = await mcpToken(agentA.id);
    expect((await tool(tok, "get_booking", { bookingId: bookingB })).isError).toBe(true);
    expect((await tool(tok, "list_bookings", {})).structuredContent).toEqual({ result: [] });
    await expect(loadAuditPage({ id: agentA.id, role: "user" }, {})).rejects.toBeInstanceOf(AuditForbiddenError);

    const { key: keyB } = await createApiKey(agentB.id, "b");
    const mine = await bookingGET(req(`/api/v1/bookings/${bookingB}`, { token: keyB }), ctx({ id: bookingB }));
    expect(mine.status).toBe(200);
    const detail = ((await mine.json()) as { data: { history: { action: string; actorLabel: string }[] } }).data;
    expect(detail.history).toEqual([expect.objectContaining({ action: "booking.create", actorLabel: "Invitee" })]);
  });

  it("lets app_user write audit entries only as itself, through its own channels and for bookings it can write", async () => {
    const { agentA, agentB, admin, bookingB } = await scene();
    const insert = (userId: string, row: { action: string; entityType: string; entityId: string | null; via: string | null }) =>
      withUser(userId, (tx) => tx`
        insert into app.audit_log (actor_user_id, action, entity_type, entity_id, via)
        values (${userId}, ${row.action}, ${row.entityType}, ${row.entityId}, ${row.via})
      `);
    const denied = { code: "42501" };
    // Another agent's booking, any channel.
    await expect(insert(agentA.id, { action: "booking.cancel", entityType: "booking", entityId: bookingB, via: "web" })).rejects.toMatchObject(denied);
    await expect(insert(agentA.id, { action: "booking.cancel", entityType: "booking", entityId: bookingB, via: "system" })).rejects.toMatchObject(denied);
    await expect(insert(agentA.id, { action: "booking.cancel", entityType: "booking", entityId: "not-a-uuid", via: "web" })).rejects.toMatchObject(denied);
    // Channels written only by the service connection.
    for (const via of ["system", "sync", "public"]) {
      await expect(insert(agentB.id, { action: "booking.cancel", entityType: "booking", entityId: bookingB, via })).rejects.toMatchObject(denied);
      await expect(insert(agentA.id, { action: "user_settings.update", entityType: "user_settings", entityId: agentA.id, via })).rejects.toMatchObject(denied);
    }
    // Allowed: the host's own booking, an admin, and non-booking entries on web, api and mcp.
    await insert(agentB.id, { action: "booking.cancel", entityType: "booking", entityId: bookingB, via: "web" });
    await insert(admin.id, { action: "booking.cancel", entityType: "booking", entityId: bookingB, via: "api" });
    await insert(agentA.id, { action: "user_settings.update", entityType: "user_settings", entityId: agentA.id, via: "mcp" });
    await insert(agentA.id, { action: "user_settings.update", entityType: "user_settings", entityId: agentA.id, via: null });
    expect((await withUser(agentB.id, (tx) => loadBookingHistory(tx, bookingB))).map((h) => h.action)).toEqual(["booking.create", "booking.cancel", "booking.cancel"]);
  });

  it("managers and admins read every booking and its history", async () => {
    const { manager, admin, bookingB } = await scene();
    for (const u of [manager, admin]) {
      expect(await withUser(u.id, (tx) => tx`select id from app.bookings where id = ${bookingB}`)).toHaveLength(1);
      expect(await withUser(u.id, (tx) => loadBookingHistory(tx, bookingB))).toHaveLength(1);
      const { key } = await createApiKey(u.id, "k");
      expect((await bookingGET(req(`/api/v1/bookings/${bookingB}`, { token: key }), ctx({ id: bookingB }))).status).toBe(200);
    }
    const page = await loadAuditPage({ id: manager.id, role: "manager" }, { entityType: "booking" });
    expect(page.entries.map((e) => e.entityId)).toEqual([bookingB]);
  });

  it("lets the new booking's reader see the reschedule entry and ignores malformed entity ids", async () => {
    const { agentA, agentB, bookingB } = await scene();
    const evA = await makeEvent(sql, { userId: agentA.id });
    const rA = await createBooking(input({ kind: "user", slug: agentA.slug }, evA.slug, futureSlot(4, 15)));
    await sql`update app.bookings set rescheduled_from_id = ${bookingB} where id = ${rA.bookingId}`;
    await sql`
      insert into app.audit_log (action, entity_type, entity_id, after, via) values
        ('booking.reschedule', 'booking', ${bookingB}, ${sql.json({ newBookingId: rA.bookingId })}, 'public'),
        ('booking.cancel', 'booking', 'not-a-uuid', null, 'system'),
        ('booking.cancel', 'booking', null, null, 'system'),
        ('booking.reschedule', 'booking', ${bookingB}, ${sql.json({ newBookingId: "nope" })}, 'public')
    `;
    const seenByA = await withUser(agentA.id, (tx) => tx<{ entity_id: string; action: string }[]>`select entity_id, action from app.audit_log order by created_at, action`);
    expect(seenByA.map((r) => [r.entity_id, r.action]).sort()).toEqual(
      [
        [rA.bookingId, "booking.create"],
        [bookingB, "booking.reschedule"],
      ].sort(),
    );
    const history = await withUser(agentA.id, (tx) => loadBookingHistory(tx, rA.bookingId));
    expect(history.map((h) => h.action)).toEqual(["booking.create", "booking.reschedule"]);
    expect(await withUser(agentB.id, (tx) => tx`select 1 from app.audit_log where entity_id = ${rA.bookingId}`)).toHaveLength(0);
  });

  it("does not expose a reschedule entry that names a booking which was not created from it", async () => {
    const { agentA, agentB, bookingB } = await scene();
    const evA = await makeEvent(sql, { userId: agentA.id });
    const rA = await createBooking(input({ kind: "user", slug: agentA.slug }, evA.slug, futureSlot(4, 15)));
    // rA.rescheduled_from_id is null, so naming rA in B's entry grants agent A nothing.
    await sql`
      insert into app.audit_log (action, entity_type, entity_id, after, via)
      values ('booking.reschedule', 'booking', ${bookingB}, ${sql.json({ newBookingId: rA.bookingId })}, 'public')
    `;
    expect(await withUser(agentA.id, (tx) => tx`select 1 from app.audit_log where entity_id = ${bookingB}`)).toHaveLength(0);
    expect((await withUser(agentA.id, (tx) => loadBookingHistory(tx, rA.bookingId))).map((h) => h.action)).toEqual(["booking.create"]);
    expect(await withUser(agentB.id, (tx) => tx`select 1 from app.audit_log where entity_id = ${bookingB}`)).toHaveLength(2);
  });

  it("loads an agent's booking history without checking unrelated reschedule entries", async () => {
    const host = await makeHost(sql, { name: "Hannah Host" });
    const ev = await makeEvent(sql, { userId: host.id });
    const r1 = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 15)));
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(2, 17) });
    // Many reschedule entries for other bookings. Before the fix, each one went through the
    // row-level security check on every history read (about 18 seconds for 50,000 rows).
    await sql`
      insert into app.audit_log (action, entity_type, entity_id, after, via)
      select 'booking.reschedule', 'booking', gen_random_uuid()::text,
             jsonb_build_object('newBookingId', gen_random_uuid()::text), 'public'
      from generate_series(1, 50000)
    `;
    await sql`analyze app.audit_log`;
    const started = performance.now();
    const history = await withUser(host.id, (tx) => loadBookingHistory(tx, r2.bookingId));
    const elapsed = performance.now() - started;
    expect(history.map((h) => h.action)).toEqual(["booking.reschedule"]);
    expect(history[0].rescheduledFromId).toBe(r1.bookingId);
    expect(elapsed).toBeLessThan(1500);
  }, 30_000);
});

describe("audit viewer data loader", () => {
  async function seed() {
    const admin = await makeUser(sql, { role: "admin", name: "Ada Admin" });
    const manager = await makeUser(sql, { role: "manager", name: "Max Manager" });
    const rows: [string | null, string, string, string, string, string][] = [
      [admin.id, "event_type.update", "event_type", "et-1", "web", "2026-10-01T10:00:00Z"],
      [admin.id, "event_type.update_reminders", "event_type", "et-1", "api", "2026-10-02T10:00:00Z"],
      [manager.id, "eventXtype.update", "other", "x-1", "mcp", "2026-10-03T10:00:00Z"],
      [null, "booking.create", "booking", "b-1", "public", "2026-10-04T10:00:00Z"],
      [null, "booking.cancel", "booking", "b-1", "system", "2026-10-05T10:00:00Z"],
    ];
    for (const [actor, action, et, eid, via, at] of rows) {
      await sql`
        insert into app.audit_log (actor_user_id, action, entity_type, entity_id, before, after, via, created_at)
        values (${actor}, ${action}, ${et}, ${eid}, ${sql.json({ name: "Old" })}, ${sql.json({ name: "New" })}, ${via}, ${at})
      `;
    }
    return { admin, manager };
  }
  const ids = (p: { entries: { action: string }[] }) => p.entries.map((e) => e.action);

  it("lets managers read entries and applies each filter", async () => {
    const { admin, manager } = await seed();
    const m = { id: manager.id, role: "manager" as const };
    expect(ids(await loadAuditPage(m, {}))).toEqual(["booking.cancel", "booking.create", "eventXtype.update", "event_type.update_reminders", "event_type.update"]);
    expect(ids(await loadAuditPage(m, { actor: admin.id }))).toEqual(["event_type.update_reminders", "event_type.update"]);
    expect(ids(await loadAuditPage(m, { entityType: "booking" }))).toEqual(["booking.cancel", "booking.create"]);
    expect(ids(await loadAuditPage(m, { entityId: "et-1" }))).toEqual(["event_type.update_reminders", "event_type.update"]);
    // Prefix match; "_" is literal, so eventXtype does not match.
    expect(ids(await loadAuditPage(m, { action: "event_type." }))).toEqual(["event_type.update_reminders", "event_type.update"]);
    expect(ids(await loadAuditPage(m, { action: "event_type.update" }))).toEqual(["event_type.update_reminders", "event_type.update"]);
    expect(ids(await loadAuditPage(m, { via: "public" }))).toEqual(["booking.create"]);
    expect(ids(await loadAuditPage(m, { from: "2026-10-02", to: "2026-10-03" }))).toEqual(["eventXtype.update", "event_type.update_reminders"]);
    // Invalid filter values are ignored rather than failing the page.
    expect(ids(await loadAuditPage(m, { via: "fax", actor: "nope" }))).toHaveLength(5);

    const [entry] = (await loadAuditPage(m, { entityType: "booking", via: "system" })).entries;
    expect(entry).toMatchObject({ actorLabel: "System", changes: [{ field: "name", path: ["name"], before: "Old", after: "New" }] });
    const [pub] = (await loadAuditPage(m, { via: "public" })).entries;
    expect(pub.actorLabel).toBe("Invitee");
  });

  it("pages with a keyset cursor without skipping entries that share a timestamp", async () => {
    const { manager } = await seed();
    for (let i = 0; i < 4; i++) {
      await sql`insert into app.audit_log (action, entity_type, via, created_at) values (${`tie.${i}`}, 'tie', 'system', '2026-10-06T10:00:00.123456Z')`;
    }
    const m = { id: manager.id, role: "manager" as const };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await loadAuditPage(m, cursor ? { cursor } : {}, { pageSize: 2 });
      seen.push(...page.entries.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });
});
