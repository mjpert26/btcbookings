import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { futureSlot, makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import type { Sql } from "@/server/db/client";
import { runJobs } from "@/server/jobs/worker";
import { createBooking } from "@/server/booking/create";
import { rescheduleByInvitee } from "@/server/booking/manage";
import { createSalesforceHandlers, enqueueSfLeadIfEnabled, enqueueSfLeadOnReschedule } from "@/server/salesforce/jobs";
import { getEffectiveSfSettings, type SfLeadMode } from "@/server/salesforce/settings";
import { listSfLeadJobs, retrySfLeadJob, saveSfSettings, SfSettingsValidationError } from "@/server/salesforce/admin";
import type { BookingInput } from "@/server/booking/types";

const LEAD = "00QHp00000AbCdEIAA";
const LEAD2 = "00QHp00000ZyXwVIAA";
const ISO = "001Hp00002abcdeIAA";
const MODES: SfLeadMode[] = ["match_or_create", "update_only", "create"];

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb(20);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
});

type Call = { url: string; body: Record<string, unknown> };

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body ?? ""), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const run = (http: ReturnType<typeof mockFetch>) => runJobs(createSalesforceHandlers({ fetch: http.fn }), { sql });

/** A booking page with Salesforce on in the given mode and a notes question. */
async function page(mode: SfLeadMode | null, opts: { team?: string; displayName?: string } = {}) {
  const host = await makeHost(sql, { name: "Rep One" });
  let ref: BookingInput["owner"];
  let ev: { id: string; slug: string };
  if (opts.team) {
    const team = await makeTeam(sql, [host.id], { name: opts.team });
    if (opts.displayName) await sql`update app.teams set page_settings = ${sql.json({ displayName: opts.displayName })} where id = ${team.id}`;
    ev = await makeEvent(sql, { teamId: team.id }, { name: "Consult" });
    ref = { kind: "team", slug: team.slug };
  } else {
    ev = await makeEvent(sql, { userId: host.id }, { name: "Consult" });
    ref = { kind: "user", slug: host.slug };
  }
  if (mode) {
    await sql`
      insert into app.event_type_sf_settings (event_type_id, create_sf_lead, lead_mode, static_values)
      values (${ev.id}, true, ${mode}, ${sql.json({ csbs__ISO__c: ISO })})`;
  }
  await sql`
    insert into app.event_type_questions (event_type_id, key, type, label, position)
    values (${ev.id}, 'help', 'textarea', ${sql.json({ en: "Anything that will help us prepare?", es: "Algo que nos ayude a preparar" })}, 1)`;
  return { host, ev, ref };
}

async function book(p: Awaited<ReturnType<typeof page>>, start = futureSlot(2, 13)) {
  return createBooking({
    owner: p.ref,
    eventSlug: p.ev.slug,
    language: "en",
    start,
    durationMin: 30,
    name: "Ana Ruiz",
    email: "Ana@Example.com",
    phone: "+13055550100",
    timezone: "America/New_York",
    answers: { help: "We have two trucks" },
  });
}

async function sfJobs() {
  return sql<{ id: string; booking_id: string; payload: Record<string, unknown>; status: string; idempotency_key: string; result: Record<string, unknown> | null; last_error: string | null; run_at: Date }[]>`
    select id, booking_id, payload, status, idempotency_key, result, last_error, run_at
    from app.jobs where kind = 'sf_lead_create' order by created_at, id`;
}

async function booking(id: string) {
  const [b] = await sql<{ sf_lead_id: string | null; sf_lead_status: string | null; status: string }[]>`
    select sf_lead_id, sf_lead_status, status from app.bookings where id = ${id}`;
  return b;
}

/** Books, then lets the first job succeed with a created Lead, as if n8n had run. */
async function bookWithLead(p: Awaited<ReturnType<typeof page>>) {
  const r = await book(p);
  await run(mockFetch([{ status: 200, body: { status: "created", leadId: LEAD } }]));
  expect(await booking(r.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "created" });
  return r;
}

describe("lead mode settings", () => {
  const input = {
    createSfLead: true,
    isoAccountId: ISO,
    fieldMapping: {},
    staticValues: {},
    campaignId: null,
    ownerMode: "assigned_host" as const,
    ownerFixedId: null,
  };

  it("defaults new rows to match_or_create", async () => {
    const p = await page(null);
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${p.ev.id}, true)`;
    const [row] = await sql`select lead_mode from app.event_type_sf_settings where event_type_id = ${p.ev.id}`;
    expect(row.lead_mode).toBe("match_or_create");
    const [col] = await sql`
      select column_default from information_schema.columns
      where table_schema = 'app' and table_name = 'event_type_sf_settings' and column_name = 'lead_mode'`;
    expect(col.column_default).toMatch(/^'match_or_create'::app\.sf_lead_mode$/);

    const admin = await makeUser(sql, { role: "admin" });
    const fresh = await page(null);
    expect((await saveSfSettings(admin, fresh.ev.id, input)).own?.leadMode).toBe("match_or_create");
  });

  it("keeps the stored mode when the input omits it", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const p = await page("create");
    const view = await saveSfSettings(admin, p.ev.id, input);
    expect(view.effective?.leadMode).toBe("create");
  });

  it("saves the mode and audits only the fields that changed", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const p = await page(null);
    let view = await saveSfSettings(admin, p.ev.id, { ...input, leadMode: "update_only" });
    expect(view.effective).toMatchObject({ createSfLead: true, leadMode: "update_only", isoAccountId: ISO });

    view = await saveSfSettings(admin, p.ev.id, { ...input, leadMode: "create" });
    expect(view.effective?.leadMode).toBe("create");
    await saveSfSettings(admin, p.ev.id, { ...input, leadMode: "create" });

    const audit = await sql<{ action: string; before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select action, before, after from app.audit_log where entity_id = ${p.ev.id} order by created_at, action`;
    const updates = audit.filter((a) => a.action === "sf_settings.update");
    // The unchanged third save writes no entry.
    expect(updates).toHaveLength(2);
    expect(updates[0].before).toMatchObject({ hasOwnSettings: false, leadMode: null, createSfLead: null });
    expect(updates[0].after).toMatchObject({ hasOwnSettings: true, leadMode: "update_only", createSfLead: true, isoAccountId: ISO });
    expect(updates[1].before).toEqual({ leadMode: "update_only" });
    expect(updates[1].after).toEqual({ leadMode: "create" });
    expect(audit.filter((a) => a.action === "sf_settings.toggle")).toHaveLength(1);
  });

  it("rejects an unknown mode", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const p = await page("match_or_create");
    await expect(saveSfSettings(admin, p.ev.id, { ...input, leadMode: "upsert" as never })).rejects.toBeInstanceOf(SfSettingsValidationError);
    await expect(saveSfSettings(admin, p.ev.id, { ...input, leadMode: "upsert" as never })).rejects.toThrow(/leadMode/);
    await expect(sql`update app.event_type_sf_settings set lead_mode = 'upsert'`).rejects.toThrow(/invalid input value for enum/);
  });

  it("lets a variant inherit the parent's mode unless it overrides the Salesforce settings", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const p = await page("update_only");
    const child = await makeEvent(sql, { userId: p.host.id }, { slug: p.ev.slug, language: "es", parentId: p.ev.id, name: "Consulta" });
    expect((await getEffectiveSfSettings(child.id)).settings?.lead_mode).toBe("update_only");

    const view = await saveSfSettings(admin, child.id, { ...input, leadMode: "create", overrideParent: true });
    expect(view).toMatchObject({ provenance: "own", overridesParent: true });
    expect((await getEffectiveSfSettings(child.id)).settings?.lead_mode).toBe("create");
    expect((await getEffectiveSfSettings(p.ev.id)).settings?.lead_mode).toBe("update_only");

    await saveSfSettings(admin, child.id, { ...input, overrideParent: false });
    expect((await getEffectiveSfSettings(child.id)).settings?.lead_mode).toBe("update_only");
  });
});

describe("enqueue", () => {
  it("enqueues one job per new booking in every mode", async () => {
    for (const mode of MODES) {
      const p = await page(mode);
      const r = await book(p);
      const jobs = (await sfJobs()).filter((j) => j.booking_id === r.bookingId);
      expect(jobs, mode).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ payload: { bookingId: r.bookingId }, idempotency_key: r.bookingId, status: "pending" });
      expect((await booking(r.bookingId)).sf_lead_status).toBe("pending");
    }
    const off = await page(null);
    const r = await book(off);
    expect((await sfJobs()).some((j) => j.booking_id === r.bookingId)).toBe(false);
  });

  it("enqueues an update job for the new booking on reschedule, except in create mode", async () => {
    for (const mode of MODES) {
      const p = await page(mode);
      const r1 = await bookWithLead(p);
      const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(3, 16) });
      const jobs = (await sfJobs()).filter((j) => j.booking_id === r2.bookingId);
      if (mode === "create") {
        expect(jobs, mode).toHaveLength(0);
        expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "created" });
        continue;
      }
      expect(jobs, mode).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ payload: { bookingId: r2.bookingId, isReschedule: true }, idempotency_key: r2.bookingId, status: "pending" });
      // The new booking carries the Lead and waits for the update.
      expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "pending" });
      expect(await booking(r1.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "created", status: "rescheduled" });
    }
  });

  it("hands a job that has not run yet over to the rescheduled booking", async () => {
    const p = await page("match_or_create");
    const r1 = await book(p);
    const [j1] = await sfJobs();
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(3, 16) });
    const [old, next] = await sfJobs();
    expect(old).toMatchObject({ id: j1.id, status: "succeeded", result: { skipped: "superseded_by_reschedule", bookingId: r2.bookingId } });
    // The original intent (match or create) moves to the new booking with the new time.
    expect(next).toMatchObject({ booking_id: r2.bookingId, payload: { bookingId: r2.bookingId }, status: "pending" });
    expect(next.payload).not.toHaveProperty("isReschedule");
    expect((await booking(r1.bookingId)).sf_lead_status).toBe("skipped");

    const http = mockFetch([{ status: 200, body: { status: "created", leadId: LEAD } }]);
    expect((await run(http)).succeeded).toBe(1);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].body).toMatchObject({ bookingId: r2.bookingId, isReschedule: false, meeting: { startUtc: new Date(futureSlot(3, 16)).toISOString().replace(".000", "") } });
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "created" });

    // A second reschedule of a booking that has its Lead now is an update.
    const r3 = await rescheduleByInvitee(r2.token, { start: futureSlot(4, 16) });
    const last = (await sfJobs()).find((j) => j.booking_id === r3.bookingId)!;
    expect(last.payload).toEqual({ bookingId: r3.bookingId, isReschedule: true });
  });

  it("never enqueues Salesforce work for imported bookings", async () => {
    const p = await page("match_or_create");
    const r = await book(p);
    await sql`delete from app.jobs`;
    await sql`update app.bookings set import_source = 'calendly', import_ref = 'https://api.calendly.com/scheduled_events/x' where id = ${r.bookingId}`;

    expect(await sql.begin((tx) => enqueueSfLeadIfEnabled(tx, r.bookingId, p.ev.id))).toBeNull();
    const [copy] = await sql<{ id: string }[]>`
      insert into app.bookings (event_type_id, status, start_at, end_at, invitee_name, invitee_email, invitee_timezone,
                                location_type, manage_token_hash, rescheduled_from_id)
      select event_type_id, 'confirmed', start_at + interval '1 day', end_at + interval '1 day', invitee_name, invitee_email,
             invitee_timezone, location_type, md5(random()::text), id
      from app.bookings where id = ${r.bookingId}
      returning id`;
    const settings = { create_sf_lead: true, lead_mode: "match_or_create" as const };
    // From an imported original: refused by the reschedule rule.
    expect(await sql.begin((tx) => enqueueSfLeadOnReschedule(tx, { oldBookingId: r.bookingId, newBookingId: copy.id, settings }))).toBeNull();
    // For an imported booking itself: dropped by the jobs_skip_imported_bookings trigger.
    expect(await sql.begin((tx) => enqueueSfLeadOnReschedule(tx, { oldBookingId: copy.id, newBookingId: r.bookingId, settings }))).toBeNull();
    expect(await sfJobs()).toHaveLength(0);
    // The imported booking's lead status is never touched.
    expect((await booking(r.bookingId)).sf_lead_status).toBe("pending");
  });

  it("the handler ignores a job whose booking is imported", async () => {
    const p = await page("match_or_create");
    const r = await book(p);
    await sql`update app.bookings set import_source = 'calendly', import_ref = 'x' where id = ${r.bookingId}`;
    const http = mockFetch([{ status: 200, body: { status: "created", leadId: LEAD } }]);
    await run(http);
    expect(http.calls).toHaveLength(0);
    expect((await sfJobs())[0]).toMatchObject({ status: "succeeded", result: { skipped: "imported_booking" } });
  });
});

describe("handler", () => {
  it("sends the mode, note text, source label, phone and ISO name", async () => {
    const p = await page("match_or_create", { team: "Acme", displayName: "Acme Partners" });
    const r = await book(p);
    const http = mockFetch([{ status: 200, body: { status: "created", leadId: LEAD } }]);
    await run(http);
    const body = http.calls[0].body;
    expect(body).toMatchObject({
      bookingId: r.bookingId,
      mode: "match_or_create",
      isReschedule: false,
      noteText: "We have two trucks",
      sourceLabel: "Acme Partners BTC Scheduler",
      mobilePhone: "+13055550100",
      isoName: "Acme Partners",
      lead: { Email: "ana@example.com", csbs__ISO__c: ISO },
      meeting: { eventTypeName: "Consult", hostName: "Rep One", isReschedule: false },
    });
    const [attempt] = await sql`select request_summary from app.job_attempts`;
    expect(attempt.request_summary).toMatchObject({ mode: "match_or_create", isReschedule: false, noteText: true });
    expect(JSON.stringify(attempt.request_summary)).not.toContain("two trucks");

    // An individual page uses the event type in the source label and has no ISO name.
    const solo = await page("update_only");
    await book(solo, futureSlot(2, 15));
    const http2 = mockFetch([{ status: 200, body: { status: "updated", leadId: LEAD } }]);
    await run(http2);
    expect(http2.calls[0].body).toMatchObject({ mode: "update_only", sourceLabel: "BTC Scheduler - Consult", isoName: null });
  });

  it("stores the matched Lead when n8n reports updated", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const p = await page("match_or_create");
    const r = await book(p);
    const http = mockFetch([{ status: 200, body: { status: "updated", leadId: LEAD, problems: ["Task create failed"] } }]);
    expect((await run(http)).succeeded).toBe(1);
    expect(await booking(r.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "updated" });
    expect((await sfJobs())[0].result).toMatchObject({ status: "updated", leadId: LEAD, mode: "match_or_create", problems: ["Task create failed"] });
    expect(await listSfLeadJobs(admin, { sfLeadStatus: ["updated"] })).toHaveLength(1);
  });

  it("fails permanently when updated has no valid Lead Id", async () => {
    const p = await page("update_only");
    const r = await book(p);
    expect((await run(mockFetch([{ status: 200, body: { status: "updated", leadId: "006Hp00000AbCdE" } }]))).dead).toBe(1);
    expect((await booking(r.bookingId)).sf_lead_status).toBe("failed");
  });

  it("records skips for converted Leads and update-only bookings without a Lead", async () => {
    const p = await page("match_or_create");
    const r = await book(p);
    const http = mockFetch([{ status: 200, body: { status: "skipped", leadId: null, matchedConvertedId: LEAD2, reason: "converted_lead" } }]);
    expect((await run(http)).succeeded).toBe(1);
    expect(await booking(r.bookingId)).toMatchObject({ sf_lead_id: null, sf_lead_status: "skipped" });
    expect((await sfJobs())[0]).toMatchObject({ status: "succeeded", result: { status: "skipped", matchedConvertedId: LEAD2, reason: "converted_lead" } });

    const u = await page("update_only");
    const r2 = await book(u, futureSlot(2, 15));
    await run(mockFetch([{ status: 200, body: { status: "skipped", leadId: null, matchedConvertedId: null, reason: "no_open_lead" } }]));
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: null, sf_lead_status: "skipped" });
    const job = (await sfJobs()).find((j) => j.booking_id === r2.bookingId)!;
    expect(job.result).toMatchObject({ reason: "no_open_lead" });
    expect(job.result).not.toHaveProperty("matchedConvertedId");
  });

  it("treats a duplicate on the create path as permanent", async () => {
    const p = await page("match_or_create");
    const r = await book(p);
    const http = mockFetch([{ status: 200, body: { status: "duplicate", leadId: null, matchedRecordId: "006Hp00000AbCdE", error: "Duplicate phone detected" } }]);
    expect((await run(http)).dead).toBe(1);
    expect(await booking(r.bookingId)).toMatchObject({ sf_lead_id: null, sf_lead_status: "duplicate" });
  });

  it("updates the Lead on a reschedule although the booking already carries it", async () => {
    const p = await page("match_or_create");
    const r1 = await bookWithLead(p);
    const start = futureSlot(3, 16);
    const r2 = await rescheduleByInvitee(r1.token, { start });
    const http = mockFetch([{ status: 200, body: { status: "updated", leadId: LEAD } }]);
    expect((await run(http)).succeeded).toBe(1);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].body).toMatchObject({
      bookingId: r2.bookingId,
      idempotencyKey: r2.bookingId,
      mode: "match_or_create",
      isReschedule: true,
      noteText: "We have two trucks",
      meeting: { isReschedule: true, startUtc: new Date(start).toISOString().replace(".000", "") },
    });
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "updated" });
    expect(await booking(r1.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "created" });
    expect((await sfJobs()).find((j) => j.booking_id === r2.bookingId)?.result).toMatchObject({ status: "updated", isReschedule: true });

    // Running the worker again does not send it twice.
    await run(http);
    expect(http.calls).toHaveLength(1);
  });

  it("skips a reschedule job when the mode was changed to create", async () => {
    const p = await page("update_only");
    const r1 = await bookWithLead(p);
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(3, 16) });
    await sql`update app.event_type_sf_settings set lead_mode = 'create'`;
    const http = mockFetch([{ status: 200, body: { status: "updated", leadId: LEAD } }]);
    await run(http);
    expect(http.calls).toHaveLength(0);
    expect((await sfJobs()).find((j) => j.booking_id === r2.bookingId)).toMatchObject({ status: "succeeded", result: { skipped: "reschedule_in_create_mode" } });
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "skipped" });
  });

  it("waits while the original booking's job is still running", async () => {
    const p = await page("match_or_create");
    const r1 = await book(p);
    const [j1] = await sfJobs();
    await sql`update app.jobs set status = 'running', attempts = 1, locked_until = now() + interval '5 minutes' where id = ${j1.id}`;
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(3, 16) });
    const j2 = (await sfJobs()).find((j) => j.booking_id === r2.bookingId)!;
    // A running job is not handed over; the new booking gets an update job.
    expect(j2.payload).toEqual({ bookingId: r2.bookingId, isReschedule: true });

    const http = mockFetch([{ status: 200, body: { status: "updated", leadId: LEAD } }]);
    const before = Date.now();
    expect((await run(http)).retried).toBe(1);
    expect(http.calls).toHaveLength(0);
    const waiting = (await sfJobs()).find((j) => j.id === j2.id)!;
    expect(waiting).toMatchObject({ status: "failed", last_error: "Waiting for the Salesforce job of the original booking" });
    expect(waiting.run_at.getTime() - before).toBeGreaterThanOrEqual(55_000);

    // The original job finishes with a Lead; the update then goes out.
    await sql`update app.jobs set status = 'succeeded', locked_until = null where id = ${j1.id}`;
    await sql`update app.bookings set sf_lead_id = ${LEAD}, sf_lead_status = 'created' where id in (${r1.bookingId}, ${r2.bookingId})`;
    await sql`update app.jobs set run_at = now() - interval '1 second' where id = ${j2.id}`;
    expect((await run(http)).succeeded).toBe(1);
    expect(http.calls[0].body).toMatchObject({ bookingId: r2.bookingId, isReschedule: true });
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "updated" });
  });

  it("re-queues a failed reschedule job and marks its booking pending again", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const p = await page("match_or_create");
    const r1 = await bookWithLead(p);
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(3, 16) });
    await run(mockFetch([{ status: 422, body: { status: "error", error: "FIELD_CUSTOM_VALIDATION_EXCEPTION", retryable: false } }]));
    const j2 = (await sfJobs()).find((j) => j.booking_id === r2.bookingId)!;
    expect(j2.status).toBe("dead");
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "failed" });

    await retrySfLeadJob(admin, j2.id);
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "pending" });
    await run(mockFetch([{ status: 200, body: { status: "updated", leadId: LEAD } }]));
    expect(await booking(r2.bookingId)).toMatchObject({ sf_lead_id: LEAD, sf_lead_status: "updated" });
  });
});
