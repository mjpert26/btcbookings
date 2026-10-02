import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost, makeTeam } from "../helpers/booking-fixtures";
import type { Sql } from "@/server/db/client";
import { createBooking } from "@/server/booking/create";
import { cancelByInvitee } from "@/server/booking/manage";
import { handleEmailSend } from "@/server/email/jobs";
import { setEmailTransport, type OutgoingEmail } from "@/server/email/send";
import { runJobs } from "@/server/jobs/worker";
import { emailHandlers } from "@/server/email/jobs";

let sql: Sql;
const sent: OutgoingEmail[] = [];
const ctx = { log: () => {} };

beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  sent.length = 0;
  setEmailTransport(async (e) => {
    sent.push(e);
    return { id: "re_test", skipped: false };
  });
});
afterEach(() => setEmailTransport(null));

async function emailJob(bookingId: string, key: string) {
  const [job] = await sql<{ id: string; payload: Record<string, unknown>; idempotency_key: string }[]>`
    select id, payload, idempotency_key from app.jobs where booking_id = ${bookingId} and kind = 'email_send' and idempotency_key = ${key}
  `;
  return job;
}

describe("email_send handler", () => {
  it("renders the English confirmation with an ICS attachment and the manage link", async () => {
    const host = await makeHost(sql, { name: "Dana Host" });
    const ev = await makeEvent(sql, { userId: host.id }, { name: "Funding consultation" });
    const who = invitee({ name: "Pat Smith" });
    const res = await createBooking({ owner: { kind: "user", slug: host.slug }, eventSlug: ev.slug, language: "en", start: futureSlot(3), durationMin: 30, ...who });
    const [b] = await sql`select id from app.bookings`;
    const out = await handleEmailSend(await emailJob(b.id, `${b.id}:confirmed`), ctx);
    expect(out).toEqual({ result: { sent: true, providerId: "re_test" } });
    expect(sent).toHaveLength(1);
    const e = sent[0];
    expect(e.to).toBe(who.email);
    expect(e.subject).toMatch(/^Confirmed: Funding consultation on /);
    expect(e.html).toContain("Your meeting is confirmed");
    expect(e.html).toContain("Dana Host");
    expect(e.html).toContain(`http://localhost:3000/b/${res.token}`);
    expect(e.html).toContain("http://localhost:3000/brand/btc-logo.png");
    expect(e.text).toContain("Hello Pat Smith,");
    expect(e.attachments?.[0].filename).toBe("invite.ics");
    expect(e.attachments?.[0].content).toContain("BEGIN:VEVENT");
    expect(e.attachments?.[0].content).toContain(`UID:${b.id}@btc-scheduler`);
    expect(e.idempotencyKey).toBe(`email_send:${b.id}:confirmed`);
    // No internal identifiers leak into the email body.
    expect(e.html).not.toContain(host.id);
    expect(e.html).not.toContain(b.id);
  });

  it("renders Spanish for a Spanish variant booking", async () => {
    const host = await makeHost(sql, { name: "Luis Host" });
    const team = await makeTeam(sql, [host.id]);
    const parent = await makeEvent(sql, { teamId: team.id }, { slug: "consulta", name: "Consultation" });
    await makeEvent(sql, { teamId: team.id }, { slug: "consulta", language: "es", parentId: parent.id, name: "Consulta" });
    await createBooking({ owner: { kind: "team", slug: team.slug }, eventSlug: "consulta", language: "es", start: futureSlot(3), durationMin: 30, ...invitee({ name: "Ana" }) });
    const [b] = await sql`select id from app.bookings`;
    await handleEmailSend(await emailJob(b.id, `${b.id}:confirmed`), ctx);
    const e = sent[0];
    expect(e.subject).toMatch(/^Confirmada: Consulta el /);
    expect(e.html).toContain("Su reunión está confirmada");
    expect(e.html).toContain('lang="es"');
    expect(e.text).toContain("Estimado(a) Ana:");
    expect(e.html).toMatch(/(lunes|martes|miércoles|jueves|viernes|sábado|domingo)/);
    expect(e.html).toContain("Reprogramar o cancelar");
  });

  it("skips confirmations and reminders for cancelled bookings but sends the cancellation", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const res = await createBooking({ owner: { kind: "user", slug: host.slug }, eventSlug: ev.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee() });
    const [b] = await sql`select id from app.bookings`;
    const confirmJob = await emailJob(b.id, `${b.id}:confirmed`);
    const reminderJob = await emailJob(b.id, `${b.id}:reminder:60`);
    await cancelByInvitee(res.token, undefined);
    expect(await handleEmailSend(confirmJob, ctx)).toEqual({ result: { skipped: "status_cancelled" } });
    expect(await handleEmailSend(reminderJob, ctx)).toEqual({ result: { skipped: "status_cancelled" } });
    const out = await handleEmailSend(await emailJob(b.id, `${b.id}:cancelled`), ctx);
    expect(out).toMatchObject({ result: { sent: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Cancelled: /);
    expect(sent[0].attachments).toBeUndefined();
    expect(sent[0].html).not.toContain(res.token);
  });

  it("skips reminders that would fire early because the start moved", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await createBooking({ owner: { kind: "user", slug: host.slug }, eventSlug: ev.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee() });
    const [b] = await sql`select id from app.bookings`;
    const job = await emailJob(b.id, `${b.id}:reminder:60`);
    expect(await handleEmailSend(job, ctx)).toEqual({ result: { skipped: "start_moved" } });
    const due = Date.parse(futureSlot(3)) - 60 * 60_000;
    expect(await handleEmailSend(job, ctx, { now: due + 1000 })).toMatchObject({ result: { sent: true } });
    expect(sent[0].subject).toMatch(/^Reminder: /);
  });

  it("sends the host notice in English to opted-in hosts, and the worker drains email jobs", async () => {
    const host = await makeHost(sql, { notifyByEmail: true, name: "Host Person" });
    const ev = await makeEvent(sql, { userId: host.id }, { language: "en" });
    await createBooking({ owner: { kind: "user", slug: host.slug }, eventSlug: ev.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee({ name: "Ivy" }) });
    const report = await runJobs(emailHandlers, { kinds: ["email_send"], sql });
    // Confirmation and host notice are due now; reminders are delayed.
    expect(report.succeeded).toBe(2);
    const notice = sent.find((e) => e.to === host.email)!;
    expect(notice.subject).toMatch(/^New booking: Intro call with Ivy on /);
    expect(notice.html).toContain("New meeting booked");
  });
});
