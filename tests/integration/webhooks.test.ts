import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import { withUser, type Sql } from "@/server/db/client";
import type { SessionUser } from "@/server/auth/session";
import { createBooking } from "@/server/booking/create";
import { cancelByInvitee, rescheduleByInvitee } from "@/server/booking/manage";
import { cancelBookingAsHost } from "@/server/booking/host-actions";
import { reassignBooking } from "@/server/booking/jobs";
import { encryptSecret } from "@/server/crypto/aes";
import { PermanentJobError } from "@/server/jobs/types";
import { handleWebhookDeliver, handleWebhookDispatch } from "@/server/webhooks/jobs";
import { signatureFor } from "@/server/webhooks/sign";
import { createWebhook, deleteWebhook, sendTestWebhook, WebhookError } from "@/server/webhooks/admin";

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

const SECRET = "whsec_integration_test_secret";
const publicDns = async () => ["93.184.216.34"];

async function endpoint(over: { events?: string[]; teamId?: string | null; url?: string; enabled?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app.webhook_endpoints (id, url, events, team_id, secret_enc, secret_prefix, enabled)
    values (${id}, ${over.url ?? "https://hooks.example.com/btc"}, ${over.events ?? ["booking.created", "booking.cancelled", "booking.rescheduled", "booking.reassigned"]},
            ${over.teamId ?? null}, ${encryptSecret(SECRET, id)}, ${SECRET.slice(0, 12)}, ${over.enabled ?? true})
  `;
  return id;
}

async function book() {
  const host = await makeHost(sql, { name: "Agent A" });
  const ev = await makeEvent(sql, { userId: host.id });
  const r = await createBooking({ owner: { kind: "user", slug: host.slug }, eventSlug: ev.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee() });
  return { host, ev, ...r };
}

const dispatchJobs = () =>
  sql<{ idempotency_key: string; payload: { bookingId: string; event: string; eventId: string; occurredAt: string } }[]>`
    select idempotency_key, payload from app.jobs where kind = 'webhook_dispatch' order by created_at, idempotency_key
  `;

function session(id: string, role: SessionUser["role"]): SessionUser {
  return { id, email: `${id}@bigthinkcapital.com`, name: "User", slug: id, role, timezone: "America/New_York", languages: ["en"], photoUrl: null, calendarStatus: null };
}

describe("webhook events", () => {
  it("adds no work when no endpoint subscribes", async () => {
    await endpoint({ events: ["booking.cancelled"], enabled: false });
    await book();
    expect(await dispatchJobs()).toHaveLength(0);
  });

  it("enqueues one dispatch per booking event from every path, and none for imported bookings", async () => {
    await endpoint();
    const a = await book();
    await cancelByInvitee(a.token, "Changed plans");
    const b = await book();
    await cancelBookingAsHost(b.host.id, b.bookingId, "Out sick");
    const jobs = await dispatchJobs();
    expect(jobs.map((j) => j.payload.event).sort()).toEqual(["booking.cancelled", "booking.cancelled", "booking.created", "booking.created"]);
    expect(new Set(jobs.map((j) => j.payload.eventId)).size).toBe(4);

    // Re-saving the same status adds nothing.
    await sql`update app.bookings set status = 'cancelled' where id = ${a.bookingId}`;
    expect(await dispatchJobs()).toHaveLength(4);

    const c = await book();
    await sql`delete from app.jobs where kind = 'webhook_dispatch'`;
    await sql`update app.bookings set import_source = 'calendly' where id = ${c.bookingId}`;
    await sql`update app.bookings set status = 'cancelled' where id = ${c.bookingId}`;
    expect(await dispatchJobs()).toHaveLength(0);
  });

  it("reports reschedules as the new booking and reassignments once per previous host", async () => {
    await endpoint();
    const a = await book();
    const moved = await rescheduleByInvitee(a.token, { start: futureSlot(4) });
    await sql`update app.booking_hosts set reassigned_at = now(), active = false where booking_id = ${moved.bookingId}`;
    await sql`update app.booking_hosts set reassigned_at = now() where booking_id = ${moved.bookingId}`;
    const events = (await dispatchJobs()).map((j) => [j.payload.event, j.payload.bookingId === moved.bookingId]);
    expect(events).toEqual(
      expect.arrayContaining([
        ["booking.created", false],
        ["booking.rescheduled", true],
        ["booking.reassigned", true],
      ]),
    );
    expect(events).toHaveLength(3);
  });

  it("sends booking.reassigned only when a round-robin reassignment finds a new host", async () => {
    await endpoint({ events: ["booking.reassigned"] });
    const a = await makeHost(sql, { name: "Agent A" });
    const b = await makeHost(sql, { name: "Agent B" });
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    const start = futureSlot(2, 13);
    const owner = { kind: "team" as const, slug: team.slug };
    // Both members are booked at the same time, so nobody is free to take the booking.
    const r = await createBooking({ owner, eventSlug: ev.slug, language: "en", start, durationMin: 30, ...invitee() });
    const other = await createBooking({ owner, eventSlug: ev.slug, language: "en", start, durationMin: 30, ...invitee() });
    const bk = { id: r.bookingId };
    const [from] = await sql<{ user_id: string }[]>`select user_id from app.booking_hosts where booking_id = ${bk.id} and active`;

    expect(await reassignBooking({ bookingId: bk.id, fromUserId: from.user_id, reason: "paused" })).toEqual({ result: { flagged: "no eligible host is free" } });
    expect(await dispatchJobs()).toHaveLength(0);
    const [kept] = await sql<{ active: boolean; reassigned_at: Date | null }[]>`
      select active, reassigned_at from app.booking_hosts where booking_id = ${bk.id} and user_id = ${from.user_id}`;
    expect(kept).toEqual({ active: true, reassigned_at: null });

    // Once the other member is free, the reassignment goes through and is reported once.
    await cancelByInvitee(other.token, "Changed plans");
    await sql`update app.bookings set status = 'confirmed', flagged_reason = null where id = ${bk.id}`;
    const moved = await reassignBooking({ bookingId: bk.id, fromUserId: from.user_id, reason: "paused" });
    expect(moved).toMatchObject({ result: { reassignedTo: expect.any(String) } });
    expect((await dispatchJobs()).map((j) => j.payload.event)).toEqual(["booking.reassigned"]);
  });

  it("reports a second reassignment of the same host on the same booking", async () => {
    await endpoint({ events: ["booking.reassigned"] });
    const a = await book();
    const host = () => sql`update app.booking_hosts set reassigned_at = now() where booking_id = ${a.bookingId}`;
    await host();
    // The host is assigned to the booking again, then moved away again.
    await sql`update app.booking_hosts set reassigned_at = null where booking_id = ${a.bookingId}`;
    await host();
    const jobs = await dispatchJobs();
    expect(jobs.map((j) => j.payload.event)).toEqual(["booking.reassigned", "booking.reassigned"]);
    expect(new Set(jobs.map((j) => j.idempotency_key)).size).toBe(2);
  });

  it("dispatches to matching endpoints only and delivers a signed payload", async () => {
    const all = await endpoint({ events: ["booking.created"] });
    await endpoint({ events: ["booking.cancelled"] });
    await endpoint({ events: ["booking.created"], teamId: (await sql<{ id: string }[]>`insert into app.teams (name, slug) values ('Other', 'other') returning id`)[0].id });
    const b = await book();
    const [job] = await dispatchJobs();

    expect(await handleWebhookDispatch(job, { sql })).toEqual({ result: { deliveries: 1 } });
    expect(await handleWebhookDispatch(job, { sql })).toEqual({ result: { deliveries: 0 } }); // idempotent
    const [delivery] = await sql<{ id: string; endpoint_id: string; payload: Record<string, unknown> }[]>`select id, endpoint_id, payload from app.webhook_deliveries`;
    expect(delivery.endpoint_id).toBe(all);
    const body = delivery.payload as { type: string; data: { booking: Record<string, unknown> } };
    expect(body.type).toBe("booking.created");
    expect(body.data.booking).toMatchObject({ id: b.bookingId, status: "confirmed", createdVia: "public", team: null });
    expect(JSON.stringify(body)).not.toContain(b.token);
    expect(await sql`select 1 from app.jobs where kind = 'webhook_deliver'`).toHaveLength(1);

    const calls: { url: string; init: RequestInit; pinned: unknown }[] = [];
    const ok = await handleWebhookDeliver(
      { payload: { deliveryId: delivery.id }, attempts: 1, max_attempts: 8 },
      { log: () => undefined },
      {
        sql,
        lookup: publicDns,
        now: () => 1_700_000_000_000,
        fetch: async (url, init, pinned) => (calls.push({ url, init, pinned }), new Response(null, { status: 204 })),
      },
    );
    expect(ok).toEqual({ result: { status: 204 } });
    // The connection goes to the address that was checked, not to a second DNS answer.
    expect(calls[0].pinned).toEqual({ address: "93.184.216.34", family: 4 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://hooks.example.com/btc");
    expect(headers["BTC-Webhook-Event"]).toBe("booking.created");
    expect(headers["BTC-Signature"]).toBe(`t=1700000000,v1=${signatureFor(SECRET, 1700000000, calls[0].init.body as string)}`);
    const [after] = await sql<{ status: string; attempts: number; response_status: number }[]>`select status, attempts, response_status from app.webhook_deliveries`;
    expect(after).toEqual({ status: "succeeded", attempts: 1, response_status: 204 });
    const [ep] = await sql<{ last_status: number; consecutive_failures: number }[]>`select last_status, consecutive_failures from app.webhook_endpoints where id = ${all}`;
    expect(ep).toEqual({ last_status: 204, consecutive_failures: 0 });
  });

  it("retries server errors, stops on client errors and refuses private destinations", async () => {
    await endpoint({ events: ["booking.created"] });
    await book();
    const [job] = await dispatchJobs();
    await handleWebhookDispatch(job, { sql });
    const [{ id }] = await sql<{ id: string }[]>`select id from app.webhook_deliveries`;
    const deliver = (status: number, lookup = publicDns, attempts = 1) =>
      handleWebhookDeliver({ payload: { deliveryId: id }, attempts, max_attempts: 8 }, { log: () => undefined }, { sql, lookup, fetch: async () => new Response(null, { status }) });

    await expect(deliver(503)).rejects.toThrow("answered 503");
    expect((await sql`select status from app.webhook_deliveries`)[0].status).toBe("pending");
    await expect(deliver(404)).rejects.toBeInstanceOf(PermanentJobError);
    expect((await sql`select status from app.webhook_deliveries`)[0].status).toBe("failed");
    await sql`update app.webhook_deliveries set status = 'pending'`;
    await expect(deliver(302)).rejects.toBeInstanceOf(PermanentJobError);
    expect((await sql`select error from app.webhook_deliveries`)[0].error).toBe("HTTP 302 (redirects are not followed)");

    let fetched = false;
    await sql`update app.webhook_deliveries set status = 'pending'`;
    await expect(
      handleWebhookDeliver(
        { payload: { deliveryId: id }, attempts: 1, max_attempts: 8 },
        { log: () => undefined },
        { sql, lookup: async () => ["10.0.0.7"], fetch: async () => ((fetched = true), new Response(null, { status: 200 })) },
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(fetched).toBe(false);
    const [row] = await sql<{ status: string; error: string }[]>`select status, error from app.webhook_deliveries`;
    expect(row).toEqual({ status: "failed", error: "URL resolves to a private or reserved address" });
    const [ep] = await sql<{ consecutive_failures: number }[]>`select consecutive_failures from app.webhook_endpoints`;
    expect(ep.consecutive_failures).toBe(4);
  });

  it("retries a delivery when DNS fails temporarily and fails it when the name does not exist", async () => {
    await endpoint({ events: ["booking.created"] });
    await book();
    const [job] = await dispatchJobs();
    await handleWebhookDispatch(job, { sql });
    const [{ id }] = await sql<{ id: string }[]>`select id from app.webhook_deliveries`;
    const failing = (code: string) => async () => {
      throw Object.assign(new Error(`queryA ${code} hooks.example.com`), { code });
    };
    let fetched = false;
    const deliver = (code: string, attempts: number) =>
      handleWebhookDeliver({ payload: { deliveryId: id }, attempts, max_attempts: 8 }, { log: () => undefined }, {
        sql,
        lookup: failing(code),
        fetch: async () => ((fetched = true), new Response(null, { status: 204 })),
      });
    const row = async () => (await sql<{ status: string; error: string }[]>`select status, error from app.webhook_deliveries`)[0];

    for (const code of ["ESERVFAIL", "ETIMEOUT", "EAI_AGAIN"]) {
      const err = await deliver(code, 1).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(Error);
      expect(err, code).not.toBeInstanceOf(PermanentJobError);
      expect(await row(), code).toEqual({ status: "pending", error: "URL host name lookup failed" });
    }
    await expect(deliver("ESERVFAIL", 8)).rejects.not.toBeInstanceOf(PermanentJobError);
    expect((await row()).status).toBe("failed");

    await sql`update app.webhook_deliveries set status = 'pending'`;
    await expect(deliver("ENOTFOUND", 1)).rejects.toBeInstanceOf(PermanentJobError);
    expect(await row()).toEqual({ status: "failed", error: "URL host name does not resolve" });
    expect(fetched).toBe(false);
  });
});

describe("webhook administration", () => {
  it("is admin only, audits changes, shows the secret once and never exposes it", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const agent = await makeUser(sql);
    await expect(createWebhook(session(agent.id, "user"), { url: "https://hooks.example.com/a", events: ["booking.created"] })).rejects.toBeInstanceOf(WebhookError);
    await expect(createWebhook(session(admin.id, "admin"), { url: "http://hooks.example.com/a", events: ["booking.created"] })).rejects.toThrow("must use https");
    await expect(createWebhook(session(admin.id, "admin"), { url: "https://127.0.0.1/a", events: ["booking.created"] })).rejects.toThrow("private");

    const { id, secret } = await createWebhook(session(admin.id, "admin"), { url: "https://hooks.example.com/a", events: ["booking.created"], description: "n8n" });
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const [audit] = await sql<{ after: Record<string, unknown> }[]>`select after from app.audit_log where action = 'webhook.create'`;
    expect(JSON.stringify(audit.after)).not.toContain(secret);

    await expect(withUser(admin.id, (tx) => tx`select secret_enc from app.webhook_endpoints`)).rejects.toMatchObject({ code: "42501" });
    expect(await withUser(agent.id, (tx) => tx`select id from app.webhook_endpoints`)).toHaveLength(0);
    expect(await withUser(admin.id, (tx) => tx`select id from app.webhook_endpoints`)).toHaveLength(1);

    await sendTestWebhook(session(admin.id, "admin"), id);
    const [test] = await sql<{ event: string; booking_id: string | null }[]>`select event, booking_id from app.webhook_deliveries`;
    expect(test).toEqual({ event: "webhook.test", booking_id: null });
    expect(await sql`select 1 from app.jobs where kind = 'webhook_deliver'`).toHaveLength(1);
    expect(await withUser(agent.id, (tx) => tx`select id from app.webhook_deliveries`)).toHaveLength(0);

    await deleteWebhook(session(admin.id, "admin"), id);
    expect(await sql`select 1 from app.webhook_endpoints`).toHaveLength(0);
    expect((await sql<{ action: string }[]>`select action from app.audit_log order by created_at`).map((r) => r.action)).toEqual(["webhook.create", "webhook.test", "webhook.delete"]);
  });

  it("writes the test delivery and its audit entry together", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const { id } = await createWebhook(session(admin.id, "admin"), { url: "https://hooks.example.com/a", events: ["booking.created"] });
    // Make the audit insert fail: the test delivery must not be created either.
    await sql.unsafe(`
      create or replace function app.test_reject_webhook_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'webhook.test' then raise exception 'audit write failed'; end if;
        return new;
      end $$;
      create trigger test_reject_webhook_audit before insert on app.audit_log
        for each row execute function app.test_reject_webhook_audit();
    `);
    try {
      await expect(sendTestWebhook(session(admin.id, "admin"), id)).rejects.toThrow("audit write failed");
    } finally {
      await sql.unsafe(`
        drop trigger if exists test_reject_webhook_audit on app.audit_log;
        drop function if exists app.test_reject_webhook_audit();
      `);
    }
    expect(await sql`select 1 from app.webhook_deliveries`).toHaveLength(0);
    expect(await sql`select 1 from app.jobs where kind = 'webhook_deliver'`).toHaveLength(0);

    await sendTestWebhook(session(admin.id, "admin"), id);
    const [audit] = await sql<{ actor_user_id: string; entity_id: string }[]>`select actor_user_id, entity_id from app.audit_log where action = 'webhook.test'`;
    expect(audit).toEqual({ actor_user_id: admin.id, entity_id: id });
    expect(await sql`select 1 from app.webhook_deliveries`).toHaveLength(1);
  });
});
