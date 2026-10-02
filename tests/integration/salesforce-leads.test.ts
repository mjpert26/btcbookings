import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { runJobs } from "@/server/jobs/worker";
import { verifySignature } from "@/server/crypto/hmac";
import { createSalesforceHandlers, enqueueSfLeadIfEnabled } from "@/server/salesforce/jobs";
import { getEffectiveSfSettings } from "@/server/salesforce/settings";
import { ForbiddenError, getSfSettings, listSfLeadJobs, retrySfLeadJob, saveSfSettings } from "@/server/salesforce/admin";

const SECRET = process.env.N8N_SIGNING_SECRET!;
const LEAD_ID = "00QHp00000AbCdEIAA";
const ISO = "001Hp00002abcdeIAA";

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

type Call = { url: string; headers: Record<string, string>; body: string };

function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fn, calls };
}

async function fixture(opts: { createSfLead?: boolean; status?: "confirmed" | "cancelled" } = {}) {
  const host = await makeUser(sql, { name: "Rep One" });
  const [et] = await sql<{ id: string }[]>`
    insert into app.event_types (owner_user_id, slug, name) values (${host.id}, 'consult', 'Consult') returning id`;
  await sql`
    insert into app.event_type_sf_settings (event_type_id, create_sf_lead, field_mapping, static_values)
    values (${et.id}, ${opts.createSfLead ?? true}, ${sql.json({ "q:company": "Company" })}, ${sql.json({ csbs__ISO__c: ISO })})`;
  const [b] = await sql<{ id: string }[]>`
    insert into app.bookings (event_type_id, status, start_at, end_at, invitee_name, invitee_email, invitee_phone,
                              invitee_timezone, location_type, manage_token_hash)
    values (${et.id}, ${opts.status ?? "confirmed"}, '2026-10-05T14:00:00Z', '2026-10-05T14:30:00Z', 'Ana Ruiz',
            'ana@example.com', '+13055550100', 'America/New_York', 'teams', ${"h" + Math.random()})
    returning id`;
  await sql`
    insert into app.booking_hosts (booking_id, user_id, role, blocked_range)
    values (${b.id}, ${host.id}, 'primary', tstzrange('2026-10-05T14:00:00Z', '2026-10-05T14:30:00Z'))`;
  await sql`insert into app.booking_answers (booking_id, question_key, value) values (${b.id}, 'company', 'Ruiz Bakery')`;
  return { host, eventTypeId: et.id, bookingId: b.id };
}

async function enqueueFor(bookingId: string, eventTypeId: string) {
  return sql.begin((tx) => enqueueSfLeadIfEnabled(tx, bookingId, eventTypeId));
}

async function booking(id: string) {
  const [b] = await sql<{ sf_lead_id: string | null; sf_lead_status: string | null }[]>`
    select sf_lead_id, sf_lead_status from app.bookings where id = ${id}`;
  return b;
}

async function job(id: string) {
  const [j] = await sql<{ status: string; attempts: number; max_attempts: number; run_at: Date; result: Record<string, unknown> | null; last_error: string | null }[]>`
    select status, attempts, max_attempts, run_at, result, last_error from app.jobs where id = ${id}`;
  return j;
}

async function makeDue(id: string) {
  await sql`update app.jobs set run_at = now() - interval '1 second' where id = ${id}`;
}

describe("sf_lead_create job", () => {
  it("enqueues once per booking and marks it pending", async () => {
    const f = await fixture();
    const id = await enqueueFor(f.bookingId, f.eventTypeId);
    expect(id).toBeTruthy();
    expect(await enqueueFor(f.bookingId, f.eventTypeId)).toBeNull();
    expect((await booking(f.bookingId)).sf_lead_status).toBe("pending");
    const [j] = await sql`select max_attempts, idempotency_key, booking_id from app.jobs where id = ${id}`;
    expect(j).toMatchObject({ max_attempts: 8, idempotency_key: f.bookingId, booking_id: f.bookingId });
  });

  it("does not enqueue when lead creation is disabled", async () => {
    const f = await fixture({ createSfLead: false });
    expect(await enqueueFor(f.bookingId, f.eventTypeId)).toBeNull();
    expect((await booking(f.bookingId)).sf_lead_status).toBeNull();
  });

  it("stores the lead id on created and signs the request", async () => {
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    const http = mockFetch([{ status: 200, body: { status: "created", leadId: LEAD_ID, error: null } }]);
    const report = await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(report.succeeded).toBe(1);
    expect(await booking(f.bookingId)).toEqual({ sf_lead_id: LEAD_ID, sf_lead_status: "created" });

    const call = http.calls[0];
    expect(call.url).toBe("https://api.bigthinkcapital.com/webhook/btc-scheduler/lead");
    expect(call.headers["idempotency-key"]).toBe(f.bookingId);
    expect(verifySignature(SECRET, call.body, call.headers["x-btc-timestamp"], call.headers["x-btc-signature"])).toEqual({ ok: true });
    expect(verifySignature("wrong", call.body, call.headers["x-btc-timestamp"], call.headers["x-btc-signature"]).ok).toBe(false);

    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      idempotencyKey: f.bookingId,
      bookingId: f.bookingId,
      owner: { mode: "assigned_host", ownerEmail: f.host.email },
      autoAssign: false,
      source: "btc-scheduler",
      lead: { FirstName: "Ana", LastName: "Ruiz", Email: "ana@example.com", Company: "Ruiz Bakery", csbs__ISO__c: ISO },
    });

    const [attempt] = await sql`select request_summary, response_code from app.job_attempts where job_id = ${jobId}`;
    expect(attempt.response_code).toBe(200);
    expect(attempt.request_summary.leadFields).toContain("Email");
    expect(JSON.stringify(attempt.request_summary)).not.toContain("ana@example.com");
    expect(JSON.stringify(attempt.request_summary)).not.toContain(SECRET);
  });

  it("treats duplicate as permanent and records the matched lead", async () => {
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    const http = mockFetch([
      { status: 200, body: { status: "duplicate", leadId: LEAD_ID, error: "Duplicate email detected", retryable: false } },
    ]);
    const report = await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(report.dead).toBe(1);
    expect(await booking(f.bookingId)).toEqual({ sf_lead_id: LEAD_ID, sf_lead_status: "duplicate" });
    const j = await job(jobId);
    expect(j.status).toBe("dead");
    expect(j.attempts).toBe(1);
    expect(j.result).toMatchObject({ status: "duplicate", leadId: LEAD_ID });
  });

  it("records a duplicate without a lead id when the match is another object", async () => {
    const f = await fixture();
    await enqueueFor(f.bookingId, f.eventTypeId);
    const http = mockFetch([
      { status: 200, body: { status: "duplicate", leadId: null, matchedRecordId: "006Hp00000AbCdE", error: "Duplicate phone" } },
    ]);
    await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(await booking(f.bookingId)).toEqual({ sf_lead_id: null, sf_lead_status: "duplicate" });
  });

  it("fails permanently on a non-retryable error", async () => {
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    const http = mockFetch([{ status: 422, body: { status: "error", error: "REQUIRED_FIELD_MISSING", retryable: false } }]);
    await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect((await job(jobId)).status).toBe("dead");
    expect((await booking(f.bookingId)).sf_lead_status).toBe("failed");
  });

  it("retries 5xx, network errors and 429 with backoff, then goes dead and marks failed", async () => {
    const f = await fixture();
    await sql`update app.event_type_sf_settings set create_sf_lead = true`;
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    await sql`update app.jobs set max_attempts = 4 where id = ${jobId}`;
    const http = mockFetch([
      { status: 503, body: "Service Unavailable" },
      new TypeError("fetch failed"),
      { status: 429, body: "", headers: { "retry-after": "120" } },
      { status: 200, body: { status: "error", error: "UNABLE_TO_LOCK_ROW", retryable: true } },
    ]);
    const handlers = createSalesforceHandlers({ fetch: http.fn });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = Date.now();
      const r = await runJobs(handlers, { sql });
      expect(r.retried).toBe(1);
      const j = await job(jobId);
      expect(j.status).toBe("failed");
      expect(j.attempts).toBe(attempt);
      expect(j.run_at.getTime()).toBeGreaterThan(before);
      if (attempt === 3) expect(j.run_at.getTime() - before).toBeGreaterThanOrEqual(115_000);
      expect((await booking(f.bookingId)).sf_lead_status).toBe("pending");
      await makeDue(jobId);
    }
    const r = await runJobs(handlers, { sql });
    expect(r.dead).toBe(1);
    expect((await job(jobId)).status).toBe("dead");
    expect((await booking(f.bookingId)).sf_lead_status).toBe("failed");
    const attempts = await sql`select attempt_no, response_code, error from app.job_attempts where job_id = ${jobId} order by attempt_no`;
    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2, 3, 4]);
    expect(attempts[0].response_code).toBe(503);
    expect(attempts[1].error).toMatch(/fetch failed/);
  });

  it("is idempotent when the booking already has a lead", async () => {
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    await sql`update app.bookings set sf_lead_id = ${LEAD_ID} where id = ${f.bookingId}`;
    const http = mockFetch([{ status: 200, body: { status: "created", leadId: "00QHp00000ZzZzZIAA" } }]);
    await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(http.calls).toHaveLength(0);
    expect(await booking(f.bookingId)).toEqual({ sf_lead_id: LEAD_ID, sf_lead_status: "created" });
    expect((await job(jobId)).result).toMatchObject({ skipped: "already_has_lead" });
  });

  it("stores the lead id when n8n reports existing", async () => {
    const f = await fixture();
    await enqueueFor(f.bookingId, f.eventTypeId);
    const http = mockFetch([{ status: 200, body: { status: "existing", leadId: LEAD_ID } }]);
    await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(await booking(f.bookingId)).toEqual({ sf_lead_id: LEAD_ID, sf_lead_status: "created" });
  });

  it("skips a booking cancelled before the send", async () => {
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    await sql`update app.bookings set status = 'cancelled' where id = ${f.bookingId}`;
    const http = mockFetch([{ status: 200, body: { status: "created", leadId: LEAD_ID } }]);
    await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(http.calls).toHaveLength(0);
    expect(await job(jobId)).toMatchObject({ status: "succeeded", result: { skipped: "booking_cancelled" } });
    expect((await booking(f.bookingId)).sf_lead_status).toBe("skipped");
  });

  it("aborts after the timeout and retries", async () => {
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    await runJobs(createSalesforceHandlers({ fetch: slow, timeoutMs: 50 }), { sql });
    expect((await job(jobId)).last_error).toMatch(/timed out/);
  });
});

describe("variant inheritance", () => {
  async function variant(parentId: string, ownerId: string, overrides: string[] = []) {
    const [v] = await sql<{ id: string }[]>`
      insert into app.event_types (owner_user_id, slug, name, language, parent_event_type_id, overrides)
      values (${ownerId}, 'consult', 'Consulta', 'es', ${parentId}, ${overrides}) returning id`;
    return v.id;
  }

  it("uses the parent's row unless sf_settings is overridden", async () => {
    const f = await fixture();
    const v = await variant(f.eventTypeId, f.host.id);
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${v}, false)`;
    const inherited = await getEffectiveSfSettings(v);
    expect(inherited).toMatchObject({ provenance: "inherited", sourceEventTypeId: f.eventTypeId });
    expect(inherited.settings?.create_sf_lead).toBe(true);

    await sql`update app.event_types set overrides = '{sf_settings}' where id = ${v}`;
    const own = await getEffectiveSfSettings(v);
    expect(own).toMatchObject({ provenance: "own", sourceEventTypeId: v });
    expect(own.settings?.create_sf_lead).toBe(false);

    const lone = await variant(f.eventTypeId, (await makeUser(sql)).id, ["sf_settings"]);
    expect(await getEffectiveSfSettings(lone)).toMatchObject({ settings: null, provenance: "none" });
  });

  it("enqueues a variant booking using the parent's settings", async () => {
    const f = await fixture();
    const v = await variant(f.eventTypeId, f.host.id);
    await sql`update app.bookings set event_type_id = ${v}, language = 'es' where id = ${f.bookingId}`;
    expect(await enqueueFor(f.bookingId, v)).toBeTruthy();
    const http = mockFetch([{ status: 200, body: { status: "created", leadId: LEAD_ID } }]);
    await runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });
    expect(JSON.parse(http.calls[0].body).lead.csbs__ISO__c).toBe(ISO);
  });
});

describe("admin functions", () => {
  const input = {
    createSfLead: true,
    isoAccountId: ISO,
    fieldMapping: { "q:company": "Company", language_name: "Customers_Preferred_Language__c" },
    staticValues: { LeadSource: "BTC Lead Engine" },
    campaignId: null,
    ownerMode: "assignment_rules" as const,
    ownerFixedId: null,
    createTask: true,
  };

  it("denies non-admins", async () => {
    const f = await fixture();
    const user = await makeUser(sql);
    await expect(getSfSettings(user, f.eventTypeId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveSfSettings(user, f.eventTypeId, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSfLeadJobs(user)).rejects.toBeInstanceOf(ForbiddenError);
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    await sql`update app.jobs set status = 'dead' where id = ${jobId}`;
    await expect(retrySfLeadJob(user, jobId)).rejects.toBeInstanceOf(ForbiddenError);
    // The database function enforces the role on its own as well.
    const { withUser } = await import("@/server/db/client");
    await expect(withUser(user.id, (tx) => tx`select * from app.retry_sf_lead_job(${jobId}, 8)`)).rejects.toThrow(/only admins/);
    expect((await job(jobId)).status).toBe("dead");
  });

  it("saves settings with the ISO as csbs__ISO__c and audits update and toggle", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const f = await fixture({ createSfLead: false });
    const view = await saveSfSettings(admin, f.eventTypeId, input);
    expect(view.provenance).toBe("own");
    expect(view.effective).toMatchObject({ createSfLead: true, isoAccountId: ISO, staticValues: { LeadSource: "BTC Lead Engine" }, createTask: true });
    const [row] = await sql`select static_values, owner_mode, updated_by from app.event_type_sf_settings where event_type_id = ${f.eventTypeId}`;
    expect(row).toMatchObject({ static_values: { LeadSource: "BTC Lead Engine", csbs__ISO__c: ISO }, owner_mode: "assignment_rules", updated_by: admin.id });

    let audit = await sql`select action, before, after from app.audit_log where entity_id = ${f.eventTypeId} order by created_at, action`;
    expect(audit.map((a) => a.action).sort()).toEqual(["sf_settings.toggle", "sf_settings.update"]);
    const toggle = audit.find((a) => a.action === "sf_settings.toggle")!;
    expect(toggle.before).toEqual({ createSfLead: false });
    expect(toggle.after).toEqual({ createSfLead: true });

    await saveSfSettings(admin, f.eventTypeId, { ...input, staticValues: {} });
    audit = await sql`select action from app.audit_log where entity_id = ${f.eventTypeId}`;
    expect(audit.filter((a) => a.action === "sf_settings.toggle")).toHaveLength(1);
    expect(audit.filter((a) => a.action === "sf_settings.update")).toHaveLength(2);
  });

  it("validates input", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const f = await fixture();
    await expect(saveSfSettings(admin, f.eventTypeId, { ...input, isoAccountId: "005Hp00000AbCdE" })).rejects.toThrow(/Account Id/);
    await expect(saveSfSettings(admin, f.eventTypeId, { ...input, fieldMapping: { "q:x": "Bad Field" } })).rejects.toThrow(/Invalid Salesforce field/);
    await expect(saveSfSettings(admin, f.eventTypeId, { ...input, ownerMode: "fixed", ownerFixedId: null })).rejects.toThrow(/Fixed owner/);
    await expect(saveSfSettings(admin, f.eventTypeId, { ...input, staticValues: { csbs__ISO__c: ISO } })).rejects.toThrow(/isoAccountId/);
    const audit = await sql`select 1 from app.audit_log where entity_id = ${f.eventTypeId}`;
    expect(audit).toHaveLength(0);
  });

  it("shows parent, own and effective settings for a variant and toggles inheritance", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const f = await fixture();
    const [v] = await sql<{ id: string }[]>`
      insert into app.event_types (owner_user_id, slug, name, language, parent_event_type_id)
      values (${f.host.id}, 'consult', 'Consulta', 'es', ${f.eventTypeId}) returning id`;

    let view = await getSfSettings(admin, v.id);
    expect(view).toMatchObject({ isVariant: true, overridesParent: false, provenance: "inherited", own: null });
    expect(view.parent?.isoAccountId).toBe(ISO);

    view = await saveSfSettings(admin, v.id, { ...input, createSfLead: false, overrideParent: true });
    expect(view).toMatchObject({ overridesParent: true, provenance: "own" });
    expect(view.effective?.createSfLead).toBe(false);

    view = await saveSfSettings(admin, v.id, { ...input, overrideParent: false });
    expect(view).toMatchObject({ overridesParent: false, provenance: "inherited" });
    expect(view.own?.createSfLead).toBe(false);
    expect(view.effective?.createSfLead).toBe(true);
    const toggles = await sql`select after from app.audit_log where entity_id = ${v.id} and action = 'sf_settings.toggle' order by created_at`;
    expect(toggles.map((t) => t.after.createSfLead)).toEqual([false, true]);
  });

  it("lists jobs with attempts and retries a dead job", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const f = await fixture();
    const jobId = (await enqueueFor(f.bookingId, f.eventTypeId))!;
    await sql`update app.jobs set max_attempts = 1 where id = ${jobId}`;
    const http = mockFetch([{ status: 502, body: "bad gateway" }, { status: 200, body: { status: "created", leadId: LEAD_ID } }]);
    const handlers = createSalesforceHandlers({ fetch: http.fn });
    await runJobs(handlers, { sql });
    expect((await job(jobId)).status).toBe("dead");
    expect((await booking(f.bookingId)).sf_lead_status).toBe("failed");

    const list = await listSfLeadJobs(admin, { status: ["dead"] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: jobId, sfLeadStatus: "failed", attempts: 1 });
    expect(list[0].attemptLog).toHaveLength(1);
    expect(list[0].attemptLog[0].responseCode).toBe(502);
    expect(await listSfLeadJobs(admin, { status: ["succeeded"] })).toHaveLength(0);

    const retried = await retrySfLeadJob(admin, jobId);
    expect(retried).toMatchObject({ status: "pending", attempts: 1, maxAttempts: 9 });
    expect((await booking(f.bookingId)).sf_lead_status).toBe("pending");
    const [audit] = await sql`select before, after from app.audit_log where action = 'sf_lead_job.retry' and entity_id = ${jobId}`;
    expect(audit.before).toMatchObject({ status: "dead", maxAttempts: 1 });
    expect(audit.after).toMatchObject({ status: "pending", maxAttempts: 9 });

    await runJobs(handlers, { sql });
    expect(await booking(f.bookingId)).toEqual({ sf_lead_id: LEAD_ID, sf_lead_status: "created" });
    const attempts = await sql`select attempt_no from app.job_attempts where job_id = ${jobId} order by attempt_no`;
    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2]);

    await expect(retrySfLeadJob(admin, jobId)).rejects.toThrow(/only dead or failed/);
  });
});
