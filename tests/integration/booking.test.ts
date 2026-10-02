import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { DateTime } from "luxon";
import { connectTestDb, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import { withUser, type Sql } from "@/server/db/client";
import { createBooking } from "@/server/booking/create";
import { cancelByInvitee, getBookingByToken, rescheduleByInvitee, rescheduleSlots } from "@/server/booking/manage";
import { getAvailableSlots } from "@/server/booking/slots";
import { reassignBooking } from "@/server/booking/jobs";
import { BookingNotFoundError, BookingValidationError, SlotTakenError, type BookingInput } from "@/server/booking/types";
import { sha256Hex } from "@/server/crypto/random";

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

function input(
  owner: BookingInput["owner"],
  eventSlug: string,
  start: string,
  over: Partial<BookingInput> = {},
): BookingInput {
  return { owner, eventSlug, language: "en", start, durationMin: 30, ...invitee(), ...over };
}

async function jobs(bookingId?: string) {
  return sql<{ kind: string; payload: Record<string, unknown>; status: string; idempotency_key: string; run_at: Date; last_error: string | null; max_attempts: number }[]>`
    select kind, payload, status, idempotency_key, run_at, last_error, max_attempts from app.jobs
    ${bookingId ? sql`where booking_id = ${bookingId}` : sql``}
    order by created_at, kind
  `;
}

async function hostOf(token: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select bh.user_id from app.booking_hosts bh join app.bookings b on b.id = bh.booking_id
    where b.manage_token_hash = ${sha256Hex(token)} and bh.active order by bh.role
  `;
  return rows.map((r) => r.user_id);
}

describe("createBooking: concurrency", () => {
  it("lets exactly one of 50 parallel bookings for one host and slot succeed", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const start = futureSlot();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => createBooking(input({ kind: "user", slug: host.slug }, ev.slug, start))),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed.every((f) => f.reason instanceof SlotTakenError)).toBe(true);
    const [{ count }] = await sql`select count(*)::int as count from app.booking_hosts where active`;
    expect(count).toBe(1);
  });

  it("assigns 50 parallel round-robin bookings to exactly the 3 free members, once each", async () => {
    const hosts = await Promise.all([makeHost(sql), makeHost(sql), makeHost(sql)]);
    const team = await makeTeam(sql, hosts.map((h) => h.id));
    const ev = await makeEvent(sql, { teamId: team.id }, { mode: "round_robin" });
    const start = futureSlot();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => createBooking(input({ kind: "team", slug: team.slug }, ev.slug, start))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(
      (results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).every((r) => r.reason instanceof SlotTakenError),
    ).toBe(true);
    const rows = await sql<{ user_id: string; n: number }[]>`
      select user_id, count(*)::int as n from app.booking_hosts where active group by user_id
    `;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set(hosts.map((h) => h.id)));
    const counters = await sql<{ rr_assignment_count: number }[]>`select rr_assignment_count from app.team_members`;
    expect(counters.map((c) => c.rr_assignment_count)).toEqual([1, 1, 1]);
  });

  it("retries round-robin with the next member when the exclusion constraint fires", async () => {
    const a = await makeHost(sql, { name: "A" });
    const b = await makeHost(sql, { name: "B" });
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    const start = futureSlot();
    // Fairness picks the member with the lowest user id first when neither was assigned.
    const first = [a.id, b.id].sort()[0];
    const other = first === a.id ? b.id : a.id;
    const other2 = await makeEvent(sql, { userId: first }, { slug: "solo" });

    // An uncommitted booking for `first` at the same time, held by another connection.
    const side = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holding = side.begin(async (tx) => {
      const [bk] = await tx`
        insert into app.bookings (event_type_id, start_at, end_at, invitee_name, invitee_email, invitee_timezone,
                                  location_type, manage_token_hash)
        values (${other2.id}, ${start}, ${new Date(Date.parse(start) + 1800_000)}, 'X', 'x@example.com', 'UTC', 'teams', 'h-side')
        returning id
      `;
      await tx`
        insert into app.booking_hosts (booking_id, user_id, blocked_range)
        values (${bk.id}, ${first}, tstzrange(${start}::timestamptz, ${start}::timestamptz + interval '30 minutes'))
      `;
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const pending = createBooking(input({ kind: "team", slug: team.slug }, ev.slug, start));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holding;
    await side.end();
    const res = await pending;
    expect(await hostOf(res.token)).toEqual([other]);
  });
});

describe("createBooking: assignment rules", () => {
  it("rotates fairly across sequential bookings", async () => {
    const hosts = await Promise.all([makeHost(sql), makeHost(sql), makeHost(sql)]);
    const team = await makeTeam(sql, hosts.map((h) => h.id));
    const ev = await makeEvent(sql, { teamId: team.id });
    const assigned: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await createBooking(input({ kind: "team", slug: team.slug }, ev.slug, futureSlot(2, 13 + i)));
      assigned.push((await hostOf(res.token))[0]);
    }
    expect(assigned.slice(3)).toEqual(assigned.slice(0, 3));
    expect(new Set(assigned.slice(0, 3)).size).toBe(3);
  });

  it("requires every member for collective events", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id }, { mode: "collective" });
    const busyStart = futureSlot(2, 15);
    await sql`
      insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at, show_as)
      values (${b.id}, 'evt-1', ${busyStart}, ${new Date(Date.parse(busyStart) + 3600_000)}, 'busy')
    `;
    await expect(createBooking(input({ kind: "team", slug: team.slug }, ev.slug, busyStart))).rejects.toBeInstanceOf(SlotTakenError);
    const ok = await createBooking(input({ kind: "team", slug: team.slug }, ev.slug, futureSlot(2, 17)));
    const rows = await sql<{ user_id: string; role: string }[]>`
      select bh.user_id, bh.role from app.booking_hosts bh join app.bookings bk on bk.id = bh.booking_id
      where bk.manage_token_hash = ${sha256Hex(ok.token)} order by bh.role desc
    `;
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([a.id, b.id]));
    expect(rows.map((r) => r.role).sort()).toEqual(["collective", "primary"]);
    expect(ok.view.hosts).toHaveLength(2);
  });

  it("never assigns paused members or members with a broken calendar", async () => {
    const good = await makeHost(sql);
    const paused = await makeHost(sql);
    const broken = await makeHost(sql, { calendar: "broken" });
    const team = await makeTeam(sql, [good.id, paused.id, broken.id]);
    await sql`update app.team_members set status = 'paused' where user_id = ${paused.id}`;
    const ev = await makeEvent(sql, { teamId: team.id });
    for (let i = 0; i < 3; i++) {
      const res = await createBooking(input({ kind: "team", slug: team.slug }, ev.slug, futureSlot(2, 13 + i)));
      expect(await hostOf(res.token)).toEqual([good.id]);
    }
    await expect(
      createBooking(input({ kind: "team", slug: team.slug }, ev.slug, futureSlot(2, 13))),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("keeps round-robin counters through pause and unpause and assigns the member again", async () => {
    const a = await makeHost(sql, { name: "A" });
    const b = await makeHost(sql, { name: "B" });
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    const ref = { kind: "team" as const, slug: team.slug };
    const r1 = await createBooking(input(ref, ev.slug, futureSlot(2, 13)));
    const firstHost = (await hostOf(r1.token))[0];
    const secondHost = firstHost === a.id ? b.id : a.id;
    const [before] = await sql`select rr_assignment_count, rr_last_assigned_at from app.team_members where user_id = ${firstHost}`;

    await sql`update app.team_members set status = 'paused' where user_id = ${firstHost}`;
    const r2 = await createBooking(input(ref, ev.slug, futureSlot(2, 14)));
    expect(await hostOf(r2.token)).toEqual([secondHost]);
    const r3 = await createBooking(input(ref, ev.slug, futureSlot(2, 15)));
    expect(await hostOf(r3.token)).toEqual([secondHost]);

    await sql`update app.team_members set status = 'active' where user_id = ${firstHost}`;
    const [after] = await sql`select rr_assignment_count, rr_last_assigned_at from app.team_members where user_id = ${firstHost}`;
    expect(after).toEqual(before);
    // firstHost was assigned longest ago, so fairness picks them next.
    const r4 = await createBooking(input(ref, ev.slug, futureSlot(2, 16)));
    expect(await hostOf(r4.token)).toEqual([firstHost]);
  });

  it("sends a returning invitee to their previous host when sticky is on", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id }, { sticky: true });
    const ref = { kind: "team" as const, slug: team.slug };
    const who = invitee();
    const r1 = await createBooking({ ...input(ref, ev.slug, futureSlot(2, 13)), ...who });
    const host1 = (await hostOf(r1.token))[0];
    const r2 = await createBooking({ ...input(ref, ev.slug, futureSlot(2, 15)), ...who, email: who.email.toUpperCase() });
    expect(await hostOf(r2.token)).toEqual([host1]);
    // A different invitee follows fairness instead.
    const r3 = await createBooking(input(ref, ev.slug, futureSlot(2, 16)));
    expect(await hostOf(r3.token)).not.toEqual([host1]);
  });

  it("respects buffers between bookings", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id }, { bufferAfter: 15 });
    const ref = { kind: "user" as const, slug: host.slug };
    await createBooking(input(ref, ev.slug, futureSlot(2, 15, 0)));
    await expect(createBooking(input(ref, ev.slug, futureSlot(2, 15, 30)))).rejects.toBeInstanceOf(SlotTakenError);
    await expect(createBooking(input(ref, ev.slug, futureSlot(2, 16, 0)))).resolves.toBeTruthy();
    const [range] = await sql<{ lo: Date; hi: Date }[]>`
      select lower(blocked_range) as lo, upper(blocked_range) as hi from app.booking_hosts order by lower(blocked_range) limit 1
    `;
    expect(range.hi.getTime() - range.lo.getTime()).toBe(45 * 60_000);
  });

  it("enforces minimum notice", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id }, { minNotice: 240 });
    const soon = DateTime.utc().plus({ hours: 2 }).startOf("hour").toISO()!;
    await expect(createBooking(input({ kind: "user", slug: host.slug }, ev.slug, soon))).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("rejects starts that are off the slot grid", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await expect(
      createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 15, 10))),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});

describe("createBooking: side effects", () => {
  it("enqueues graph, confirmation and reminder jobs and stores the token hashed and encrypted", async () => {
    const host = await makeHost(sql, { notifyByEmail: true });
    const ev = await makeEvent(sql, { userId: host.id }, { reminders: [1440, 60, 100000] });
    const res = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2)));
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [b] = await sql<{ id: string; manage_token_hash: string; manage_token_enc: string; sf_lead_status: string | null }[]>`
      select id, manage_token_hash, manage_token_enc, sf_lead_status from app.bookings
    `;
    expect(b.manage_token_hash).toBe(sha256Hex(res.token));
    expect(b.manage_token_enc).not.toContain(res.token);
    expect(b.sf_lead_status).toBeNull();
    const js = await jobs(b.id);
    const keys = js.map((j) => `${j.kind}:${j.idempotency_key}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        `graph_event_upsert:${b.id}:upsert`,
        `email_send:${b.id}:confirmed`,
        `email_send:${b.id}:reminder:1440`,
        `email_send:${b.id}:reminder:60`,
        `email_send:${b.id}:host_notice:created:${host.id}`,
      ]),
    );
    // The 100000-minute reminder would be in the past.
    expect(keys.some((k) => k.endsWith(":reminder:100000"))).toBe(false);
    expect(js.some((j) => j.kind === "sf_lead_create")).toBe(false);
    const reminder = js.find((j) => j.idempotency_key === `${b.id}:reminder:60`)!;
    expect(reminder.run_at.getTime()).toBe(Date.parse(futureSlot(2)) - 60 * 60_000);
  });

  it("returns the same booking for an idempotent double submit", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const base = input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2), { idempotencyKey: "client-key-123456" });
    const [r1, r2] = await Promise.all([createBooking(base), createBooking(base)]);
    expect(r1.token).toBe(r2.token);
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    const r3 = await createBooking(base);
    expect(r3.token).toBe(r1.token);
    const [{ count }] = await sql`select count(*)::int as count from app.bookings`;
    expect(count).toBe(1);
  });

  it("validates input and answers server-side", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id }, { durations: [30, 60] });
    await sql`
      insert into app.event_type_questions (event_type_id, key, type, label, options, required, position) values
      (${ev.id}, 'company', 'text', ${sql.json({ en: "Company" })}, '[]', true, 1),
      (${ev.id}, 'size', 'dropdown', ${sql.json({ en: "Size" })}, ${sql.json([{ value: "small", label: { en: "Small" } }, { value: "large", label: { en: "Large" } }] as never)}, false, 2),
      (${ev.id}, 'cc', 'email', ${sql.json({ en: "CC" })}, '[]', false, 3),
      (${ev.id}, 'agree', 'checkbox', ${sql.json({ en: "Agree" })}, '[]', true, 4),
      (${ev.id}, 'phone', 'phone', ${sql.json({ en: "Phone" })}, '[]', true, 5)
    `;
    const ref = { kind: "user" as const, slug: host.slug };
    const start = futureSlot(2);
    const err = await createBooking(
      input(ref, ev.slug, start, { answers: { size: "medium", cc: "nope", agree: false, extra: "x" } }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BookingValidationError);
    expect(err.fieldErrors).toMatchObject({
      company: "required",
      size: "invalid_option",
      cc: "invalid_email",
      agree: "required",
      phone: "required",
      extra: "unknown_question",
    });
    await expect(createBooking(input(ref, ev.slug, start, { timezone: "Mars/Olympus" }))).rejects.toBeInstanceOf(
      BookingValidationError,
    );
    await expect(createBooking(input(ref, ev.slug, start, { email: "not-an-email" }))).rejects.toBeInstanceOf(
      BookingValidationError,
    );
    await expect(createBooking(input(ref, ev.slug, start, { durationMin: 45 }))).rejects.toBeInstanceOf(
      BookingValidationError,
    );
    await expect(createBooking(input(ref, ev.slug, start, { name: "x".repeat(500) }))).rejects.toBeInstanceOf(
      BookingValidationError,
    );
    const ok = await createBooking(
      input(ref, ev.slug, start, {
        durationMin: 60,
        phone: "+1 (555) 010-2000",
        answers: { company: "Acme", size: "large", cc: "Boss@Example.com", agree: true },
      }),
    );
    expect(ok.view.durationMin).toBe(60);
    const answers = await sql`select question_key, value from app.booking_answers order by question_key`;
    expect(answers.map((a) => [a.question_key, a.value])).toEqual([
      ["agree", "true"],
      ["cc", "boss@example.com"],
      ["company", "Acme"],
      ["phone", "+1 (555) 010-2000"],
      ["size", "large"],
    ]);
  });

  it("returns not found for inactive event types and inactive users", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id }, { isActive: false });
    await expect(createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot()))).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
    const ev2 = await makeEvent(sql, { userId: host.id }, { isListed: false });
    await expect(createBooking(input({ kind: "user", slug: host.slug }, ev2.slug, futureSlot()))).resolves.toBeTruthy();
    await sql`update app.users set is_active = false where id = ${host.id}`;
    await expect(
      createBooking(input({ kind: "user", slug: host.slug }, ev2.slug, futureSlot(3))),
    ).rejects.toBeInstanceOf(BookingNotFoundError);
  });
});

describe("Salesforce lead enqueue and variants", () => {
  it("routes a variant to its own pool but uses the parent's Salesforce settings", async () => {
    const en = await makeHost(sql, { name: "English rep" });
    const es = await makeHost(sql, { name: "Spanish rep" });
    const team = await makeTeam(sql, [en.id, es.id]);
    const parent = await makeEvent(sql, { teamId: team.id }, { slug: "consult", language: "en" });
    const child = await makeEvent(sql, { teamId: team.id }, { slug: "consult", language: "es", parentId: parent.id, name: "Consulta" });
    await sql`insert into app.event_type_hosts (event_type_id, team_member_id) values (${parent.id}, ${team.memberIds[en.id]})`;
    await sql`insert into app.event_type_hosts (event_type_id, team_member_id) values (${child.id}, ${team.memberIds[es.id]})`;
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${parent.id}, true)`;

    const ref = { kind: "team" as const, slug: team.slug };
    const r = await createBooking(input(ref, "consult", futureSlot(2, 13), { language: "es" }));
    expect(await hostOf(r.token)).toEqual([es.id]);
    expect(r.view.language).toBe("es");
    const [b] = await sql`select id, sf_lead_status, language from app.bookings`;
    expect(b).toMatchObject({ sf_lead_status: "pending", language: "es" });
    const sf = (await jobs(b.id)).filter((j) => j.kind === "sf_lead_create");
    expect(sf).toHaveLength(1);
    expect(sf[0].idempotency_key).toBe(b.id);
    expect(sf[0].max_attempts).toBe(8);

    // The English page routes to the English pool.
    const rEn = await createBooking(input(ref, "consult", futureSlot(2, 13)));
    expect(await hostOf(rEn.token)).toEqual([en.id]);

    // Variant overrides sf_settings with its own row: no lead.
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${child.id}, false)`;
    const r2 = await createBooking(input(ref, "consult", futureSlot(2, 15), { language: "es" }));
    const [b2] = await sql`select id, sf_lead_status from app.bookings where manage_token_hash = ${sha256Hex(r2.token)}`;
    expect(b2.sf_lead_status).toBeNull();
    expect((await jobs(b2.id)).some((j) => j.kind === "sf_lead_create")).toBe(false);
  });

  it("does not enqueue a lead when Salesforce is disabled", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${ev.id}, false)`;
    await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot()));
    expect((await jobs()).some((j) => j.kind === "sf_lead_create")).toBe(false);
  });
});

describe("invitee manage flows", () => {
  it("cancels: hosts released, Outlook delete enqueued, reminders cancelled, lead untouched", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${ev.id}, true)`;
    const res = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(3)));
    await sql`update app.booking_hosts set graph_event_id = 'AAMk-1'`;
    const view = await cancelByInvitee(res.token, "Schedule conflict");
    expect(view.status).toBe("cancelled");
    expect(view.canCancel).toBe(false);
    const [b] = await sql`select id, status, cancelled_by, cancel_reason, sf_lead_status from app.bookings`;
    expect(b).toMatchObject({ status: "cancelled", cancelled_by: "invitee", cancel_reason: "Schedule conflict", sf_lead_status: "pending" });
    expect(await sql`select 1 from app.booking_hosts where active`).toHaveLength(0);
    const js = await jobs(b.id);
    const del = js.find((j) => j.kind === "graph_event_delete")!;
    expect(del.payload).toEqual({ bookingId: b.id, userId: host.id, graphEventId: "AAMk-1" });
    const reminders = js.filter((j) => j.payload.template === "booking_reminder");
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.every((j) => j.status === "dead" && j.last_error === "booking cancelled")).toBe(true);
    expect(js.some((j) => j.idempotency_key === `${b.id}:cancelled`)).toBe(true);
    expect(js.filter((j) => j.kind === "sf_lead_create")).toHaveLength(1);
    // The slot is free again.
    await expect(createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(3)))).resolves.toBeTruthy();
    await expect(cancelByInvitee(res.token, undefined)).rejects.toThrow();
  });

  it("reschedules to a linked booking, prefers the original host, and never enqueues a second lead", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${ev.id}, true)`;
    const ref = { kind: "team" as const, slug: team.slug };
    const r1 = await createBooking(input(ref, ev.slug, futureSlot(2, 13)));
    const original = (await hostOf(r1.token))[0];
    await sql`update app.bookings set sf_lead_id = '00Q000000000001AAA', sf_lead_status = 'created'`;
    // Fairness alone would now pick the other member.
    const slots = await rescheduleSlots(r1.token, { from: new Date(Date.parse(futureSlot(2, 0))), to: new Date(Date.parse(futureSlot(3, 0))) });
    expect(slots.some((s) => s.start === new Date(futureSlot(2, 13)).toISOString())).toBe(true);
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(2, 16) });
    expect(r2.token).not.toBe(r1.token);
    expect(await hostOf(r2.token)).toEqual([original]);

    const rows = await sql<{ id: string; status: string; rescheduled_from_id: string | null; sf_lead_id: string | null; sf_lead_status: string | null }[]>`
      select id, status, rescheduled_from_id, sf_lead_id, sf_lead_status from app.bookings order by created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("rescheduled");
    expect(rows[1]).toMatchObject({ status: "confirmed", rescheduled_from_id: rows[0].id, sf_lead_id: "00Q000000000001AAA", sf_lead_status: "created" });
    expect((await jobs()).filter((j) => j.kind === "sf_lead_create")).toHaveLength(1);
    const oldJobs = await jobs(rows[0].id);
    expect(oldJobs.some((j) => j.kind === "graph_event_delete")).toBe(true);
    expect(oldJobs.filter((j) => j.payload.template === "booking_reminder").every((j) => j.status === "dead")).toBe(true);
    const newJobs = await jobs(rows[1].id);
    expect(newJobs.map((j) => j.idempotency_key)).toEqual(
      expect.arrayContaining([`${rows[1].id}:upsert`, `${rows[1].id}:rescheduled`, `${rows[1].id}:reminder:60`]),
    );
    expect(await getBookingByToken(r1.token)).toMatchObject({ status: "rescheduled", canCancel: false, canReschedule: false });
    // Answers copied, counters unchanged for the kept host.
    const [{ count }] = await sql`select rr_assignment_count as count from app.team_members where user_id = ${original}`;
    expect(count).toBe(1);
  });

  it("can reschedule into a time overlapping its own current hold", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id }, { durations: [60] });
    await sql`update app.event_types set slot_interval_min = 30 where id = ${ev.id}`;
    const r1 = await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot(2, 15, 0), { durationMin: 60 }));
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(2, 15, 30) });
    expect(r2.view.start).toBe(new Date(futureSlot(2, 15, 30)).toISOString());
    expect(r2.view.durationMin).toBe(60);
  });
});

describe("slots API and RLS", () => {
  it("returns ISO start/end pairs only", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const from = new Date(Date.parse(futureSlot(2, 0)));
    const to = new Date(from.getTime() + 86_400_000);
    const slots = await getAvailableSlots({ kind: "user", slug: host.slug }, ev.slug, "en", { from, to });
    expect(slots.length).toBeGreaterThan(10);
    expect(Object.keys(slots[0]).sort()).toEqual(["end", "start"]);
    expect(JSON.stringify(slots)).not.toContain(host.id);
    await expect(getAvailableSlots({ kind: "user", slug: host.slug }, "nope", "en", { from, to })).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
  });

  it("never lets app_user read bookings.manage_token_enc", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await createBooking(input({ kind: "user", slug: host.slug }, ev.slug, futureSlot()));
    await expect(withUser(host.id, (tx) => tx`select manage_token_enc from app.bookings`)).rejects.toThrow(/permission denied/);
    await expect(withUser(host.id, (tx) => tx`select * from app.bookings`)).rejects.toThrow(/permission denied/);
    const rows = await withUser(host.id, (tx) => tx`select id, status, invitee_email, sf_lead_status from app.bookings`);
    expect(rows).toHaveLength(1);
    const other = await makeHost(sql);
    expect(await withUser(other.id, (tx) => tx`select id from app.bookings`)).toHaveLength(0);
    // Host-side status updates keep working under RLS.
    const updated = await withUser(host.id, (tx) => tx`update app.bookings set status = 'flagged', flagged_reason = 'test' returning id`);
    expect(updated).toHaveLength(1);
  });
});

describe("booking_reassign", () => {
  it("moves a round-robin booking to another free member and notifies the invitee", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id }, { minNotice: 0 });
    const r = await createBooking(input({ kind: "team", slug: team.slug }, ev.slug, futureSlot(2, 13)));
    const from = (await hostOf(r.token))[0];
    const to = from === a.id ? b.id : a.id;
    await sql`update app.team_members set status = 'paused' where user_id = ${from}`;
    const [bk] = await sql`select id from app.bookings`;
    const out = await reassignBooking({ bookingId: bk.id, fromUserId: from, reason: "removed from queue" });
    expect(out).toEqual({ result: { reassignedTo: to } });
    expect(await hostOf(r.token)).toEqual([to]);
    const js = await jobs(bk.id);
    expect(js.some((j) => j.kind === "graph_event_delete" && j.payload.userId === from)).toBe(true);
    expect(js.some((j) => j.idempotency_key === `${bk.id}:upsert:reassign:${to}`)).toBe(true);
    expect(js.some((j) => j.idempotency_key === `${bk.id}:rescheduled:reassign:${to}`)).toBe(true);
  });

  it("flags the booking when nobody else is free", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    const start = futureSlot(2, 13);
    const ref = { kind: "team" as const, slug: team.slug };
    const r = await createBooking(input(ref, ev.slug, start));
    await createBooking(input(ref, ev.slug, start));
    const from = (await hostOf(r.token))[0];
    const [bk] = await sql`select id from app.bookings where manage_token_hash = ${sha256Hex(r.token)}`;
    const out = await reassignBooking({ bookingId: bk.id, fromUserId: from, reason: "paused" });
    expect(out).toEqual({ result: { flagged: "no eligible host is free" } });
    const [row] = await sql`select status, flagged_reason from app.bookings where id = ${bk.id}`;
    expect(row.status).toBe("flagged");
    expect(row.flagged_reason).toContain("paused");
    expect(await hostOf(r.token)).toEqual([from]);
  });
});
