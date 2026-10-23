import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import { withUser, type Sql } from "@/server/db/client";
import { createBooking } from "@/server/booking/create";
import { loadPublicEventType, toPublicEventType } from "@/server/booking/load";
import { cancelByInvitee, rescheduleByInvitee } from "@/server/booking/manage";
import { cancelBookingAsHost } from "@/server/booking/host-actions";
import { reassignBooking } from "@/server/booking/jobs";
import { enqueueAllReminders, DEFAULT_REMINDER_SETTINGS } from "@/server/booking/side-effects";
import { handleEmailSend } from "@/server/email/jobs";
import { setEmailTransport, type OutgoingEmail } from "@/server/email/send";
import { handleSmsSend } from "@/server/sms/jobs";
import { setSmsTransport, type SmsMessage } from "@/server/sms/sendblue";
import { handleInboundSms } from "@/server/sms/inbound";
import { createSlackClient, SlackNotConfiguredError } from "@/server/slack/client";
import { handleSlackDm } from "@/server/slack/dm-jobs";

let sql: Sql;
const ctx = { log: () => {} };
const emails: OutgoingEmail[] = [];
const texts: SmsMessage[] = [];
const SECRET = "inbound-secret-0000000";

beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  emails.length = 0;
  texts.length = 0;
  setEmailTransport(async (e) => {
    emails.push(e);
    return { id: "re_test", skipped: false };
  });
  setSmsTransport(async (m) => {
    texts.push(m);
    return { messageHandle: "mh_test", status: "QUEUED", skipped: false };
  });
});
afterEach(() => {
  setEmailTransport(null);
  setSmsTransport(null);
});

type JobRowT = { id: string; kind: string; payload: Record<string, unknown>; idempotency_key: string; status: string; run_at: Date; last_error: string | null };

async function jobsFor(bookingId: string): Promise<JobRowT[]> {
  return sql<JobRowT[]>`
    select id, kind, payload, idempotency_key, status, run_at, last_error from app.jobs where booking_id = ${bookingId} order by kind, idempotency_key
  `;
}

const isReminder = (j: JobRowT) =>
  ((j.kind === "email_send" && (j.payload.template === "booking_reminder" || j.payload.template === "host_booking_reminder")) ||
    j.kind === "sms_send" ||
    j.kind === "slack_dm_send");

const isAgentReminder = (j: JobRowT) =>
  (j.kind === "email_send" && j.payload.template === "host_booking_reminder") ||
  j.kind === "slack_dm_send" ||
  (j.kind === "sms_send" && j.payload.recipient !== "invitee");

async function teamSetup(opts: { channels?: boolean; partner?: string; locationType?: "teams" | "phone" } = {}) {
  const host = await makeHost(sql, { name: "Dana Host", timezone: "America/Los_Angeles" });
  const team = await makeTeam(sql, [host.id], { name: opts.partner ?? "Acme ISO" });
  const ev = await makeEvent(sql, { teamId: team.id }, { name: "Funding consultation", locationType: opts.locationType ?? "teams" });
  if (opts.channels !== false) {
    await sql`
      update app.event_types
      set merchant_reminder_channels = '{email,sms}', agent_reminder_channels = '{email,slack,sms}',
          agent_reminder_offsets_min = '{15,60}', reminder_offsets_min = '{1440,60}'
      where id = ${ev.id}
    `;
  }
  await sql`update app.user_settings set sms_phone = '+13105550199' where user_id = ${host.id}`;
  await sql`insert into app.event_type_questions (event_type_id, key, type, label, position) values (${ev.id}, 'company', 'text', ${sql.json({ en: "Company" })}, 0)`;
  return { host, team, ev };
}

async function book(
  team: { slug: string },
  ev: { slug: string },
  over: { phone?: string | null; language?: "en" | "es"; start?: string; smsConsent?: boolean } = {},
) {
  const res = await createBooking({
    owner: { kind: "team", slug: team.slug },
    eventSlug: ev.slug,
    language: over.language ?? "en",
    start: over.start ?? futureSlot(3),
    durationMin: 30,
    ...invitee({ name: "Pat Smith" }),
    phone: over.phone === undefined ? "(212) 555-0142" : over.phone,
    smsConsent: over.smsConsent ?? true,
    answers: { company: "Pat's Pizza" },
  });
  return res;
}

describe("reminder scheduling", () => {
  it("keeps today's behaviour by default: merchant email reminders only", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await createBooking({ owner: { kind: "user", slug: host.slug }, eventSlug: ev.slug, language: "en", start: futureSlot(3), durationMin: 30, ...invitee() });
    const [b] = await sql<{ id: string }[]>`select id from app.bookings`;
    const [et] = await sql`select merchant_reminder_channels, agent_reminder_channels, agent_reminder_offsets_min from app.event_types where id = ${ev.id}`;
    expect(et).toEqual({ merchant_reminder_channels: ["email"], agent_reminder_channels: [], agent_reminder_offsets_min: [15] });
    const reminders = (await jobsFor(b.id)).filter(isReminder);
    expect(reminders.map((j) => `${j.kind}:${j.idempotency_key}`).sort()).toEqual([
      `email_send:${b.id}:reminder:1440`,
      `email_send:${b.id}:reminder:60`,
    ]);
    expect(DEFAULT_REMINDER_SETTINGS).toEqual({ merchantOffsetsMin: [1440, 60], merchantChannels: ["email"], agentChannels: [], agentOffsetsMin: [15] });
  });

  it("enqueues every enabled channel with per booking, channel, recipient and offset keys", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    await book(team, ev, { start });
    const [b] = await sql<{ id: string }[]>`select id from app.bookings`;
    const reminders = (await jobsFor(b.id)).filter(isReminder);
    expect(reminders.map((j) => `${j.kind}:${j.idempotency_key}`).sort()).toEqual(
      [
        `email_send:${b.id}:reminder:1440`,
        `email_send:${b.id}:reminder:60`,
        `email_send:${b.id}:host_reminder:${host.id}:15`,
        `email_send:${b.id}:host_reminder:${host.id}:60`,
        `slack_dm_send:${b.id}:slack_dm:${host.id}:15`,
        `slack_dm_send:${b.id}:slack_dm:${host.id}:60`,
        `sms_send:${b.id}:sms:invitee:1440`,
        `sms_send:${b.id}:sms:invitee:60`,
        `sms_send:${b.id}:sms:${host.id}:15`,
        `sms_send:${b.id}:sms:${host.id}:60`,
      ].sort(),
    );
    const slack15 = reminders.find((j) => j.idempotency_key === `${b.id}:slack_dm:${host.id}:15`)!;
    expect(slack15.run_at.getTime()).toBe(Date.parse(start) - 15 * 60_000);
    expect(slack15.payload).toEqual({ template: "booking_reminder", bookingId: b.id, userId: host.id, offsetMin: 15 });
    // Re-enqueueing is idempotent.
    await enqueueAllReminders(sql, { bookingId: b.id, startMs: Date.parse(start), hostUserIds: [host.id] });
    expect((await jobsFor(b.id)).filter(isReminder)).toHaveLength(10);
  });

  it("cancels pending reminders on every channel when the invitee cancels", async () => {
    const { team, ev } = await teamSetup();
    const res = await book(team, ev);
    await cancelByInvitee(res.token, undefined);
    const reminders = (await jobsFor(res.bookingId)).filter(isReminder);
    expect(reminders).toHaveLength(10);
    expect(reminders.every((j) => j.status === "dead" && j.last_error === "booking cancelled")).toBe(true);
  });

  it("moves reminders to the new booking on reschedule", async () => {
    const { team, ev } = await teamSetup();
    const r1 = await book(team, ev, { start: futureSlot(3) });
    const r2 = await rescheduleByInvitee(r1.token, { start: futureSlot(4) });
    const old = (await jobsFor(r1.bookingId)).filter(isReminder);
    expect(old.every((j) => j.status === "dead")).toBe(true);
    const fresh = (await jobsFor(r2.bookingId)).filter(isReminder);
    expect(fresh).toHaveLength(10);
    expect(fresh.every((j) => j.status === "pending")).toBe(true);
  });

  it("cancels pending reminders when a host cancels", async () => {
    const { host, team, ev } = await teamSetup();
    const res = await book(team, ev);
    expect(await cancelBookingAsHost(host.id, res.bookingId, null)).toEqual({ ok: true, alreadyCancelled: false });
    const reminders = (await jobsFor(res.bookingId)).filter(isReminder);
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.every((j) => j.status === "dead")).toBe(true);
  });

  it("moves agent reminders to the new host when a booking is reassigned", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    await sql`update app.event_types set agent_reminder_channels = '{slack}', agent_reminder_offsets_min = '{15}' where id = ${ev.id}`;
    await sql`insert into app.event_type_questions (event_type_id, key, type, label, position) values (${ev.id}, 'company', 'text', ${sql.json({ en: "Company" })}, 0)`;
    const res = await book(team, ev);
    const [{ user_id: from }] = await sql<{ user_id: string }[]>`select user_id from app.booking_hosts where booking_id = ${res.bookingId} and active`;
    const to = from === a.id ? b.id : a.id;
    await sql`update app.team_members set status = 'paused' where user_id = ${from}`;
    expect(await reassignBooking({ bookingId: res.bookingId, fromUserId: from, reason: "removed from queue" })).toEqual({ result: { reassignedTo: to } });
    const slack = (await jobsFor(res.bookingId)).filter((j) => j.kind === "slack_dm_send");
    expect(slack.find((j) => j.payload.userId === from)?.status).toBe("dead");
    expect(slack.find((j) => j.payload.userId === to)?.status).toBe("pending");
    // Merchant reminders are untouched.
    expect((await jobsFor(res.bookingId)).filter((j) => j.payload.template === "booking_reminder" && j.kind === "email_send").every((j) => j.status === "pending")).toBe(true);
  });

  it("gives a host who gets a booking back new reminders and Outlook jobs on every move", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id });
    await sql`update app.event_types set agent_reminder_channels = '{email,slack,sms}', agent_reminder_offsets_min = '{15}' where id = ${ev.id}`;
    await sql`insert into app.event_type_questions (event_type_id, key, type, label, position) values (${ev.id}, 'company', 'text', ${sql.json({ en: "Company" })}, 0)`;
    const res = await book(team, ev);
    const [{ user_id: x }] = await sql<{ user_id: string }[]>`select user_id from app.booking_hosts where booking_id = ${res.bookingId} and active`;
    const y = x === a.id ? b.id : a.id;

    const hop = async (from: string, to: string, n: number) => {
      await sql`update app.team_members set status = 'paused' where user_id = ${from}`;
      await sql`update app.team_members set status = 'active' where user_id = ${to}`;
      expect(await reassignBooking({ bookingId: res.bookingId, fromUserId: from, reason: `hop ${n}` }, { reassignId: randomUUID() })).toEqual({
        result: { reassignedTo: to },
      });
      const js = await jobsFor(res.bookingId);
      const recipientOf = (j: JobRowT) => (j.payload.userId ?? (j.payload.recipient as { userId?: string } | undefined)?.userId) as string | undefined;
      const pendingFor = (u: string) => js.filter((j) => isReminder(j) && j.status === "pending" && recipientOf(j) === u);
      // One pending reminder per channel for the current host, none for the previous one.
      expect(pendingFor(to)).toHaveLength(3);
      expect(pendingFor(from)).toHaveLength(0);
      return js;
    };

    await hop(x, y, 1);
    await hop(y, x, 2);
    const js = await hop(x, y, 3);
    const deletes = js.filter((j) => j.kind === "graph_event_delete");
    expect(deletes.filter((j) => j.payload.userId === x)).toHaveLength(2);
    expect(deletes.filter((j) => j.payload.userId === y)).toHaveLength(1);
    expect(js.filter((j) => j.kind === "graph_event_upsert" && j.idempotency_key.startsWith(`${res.bookingId}:upsert:reassign:${y}:`))).toHaveLength(2);
    expect(js.filter((j) => j.kind === "email_send" && j.idempotency_key.startsWith(`${res.bookingId}:rescheduled:reassign:`))).toHaveLength(3);
  });

  it("does not revive reminders of a cancelled booking", async () => {
    const { host, team, ev } = await teamSetup();
    const res = await book(team, ev);
    await cancelByInvitee(res.token, undefined);
    const [b] = await sql<{ start_at: Date }[]>`select start_at from app.bookings where id = ${res.bookingId}`;
    await enqueueAllReminders(sql, { bookingId: res.bookingId, startMs: b.start_at.getTime(), hostUserIds: [host.id] });
    expect((await jobsFor(res.bookingId)).filter(isReminder).every((j) => j.status === "dead")).toBe(true);
  });

  it("never enqueues reminders for imported bookings", async () => {
    const { host, ev } = await teamSetup();
    const id = randomUUID();
    const start = new Date(Date.parse(futureSlot(3)));
    await sql`
      insert into app.bookings (id, event_type_id, start_at, end_at, invitee_name, invitee_email, invitee_timezone, location_type, manage_token_hash, import_source, import_ref)
      values (${id}, ${ev.id}, ${start}, ${new Date(start.getTime() + 30 * 60_000)}, 'Imported', 'imp@example.com', 'UTC', 'teams', ${randomUUID()}, 'calendly', 'ref-1')
    `;
    await enqueueAllReminders(sql, { bookingId: id, startMs: start.getTime(), hostUserIds: [host.id] });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.jobs where booking_id = ${id} or payload ->> 'bookingId' = ${id}`;
    expect(n).toBe(0);
  });
});

async function job(bookingId: string, kind: string, key: string) {
  const [j] = await sql<{ id: string; payload: Record<string, unknown>; idempotency_key: string }[]>`
    select id, payload, idempotency_key from app.jobs where booking_id = ${bookingId} and kind = ${kind} and idempotency_key = ${key}
  `;
  return j;
}

describe("sms_send", () => {
  it("texts the merchant in their language with the partner name and opt-out line", async () => {
    const { team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const now = Date.parse(start) - 60 * 60_000;
    const out = await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`), ctx, { now });
    expect(out).toEqual({ result: { sent: true, providerId: "mh_test", status: "QUEUED" } });
    expect(texts[0].to).toBe("+12125550142");
    expect(texts[0].content).toContain("Funding consultation");
    expect(texts[0].content).toContain("Partner: Acme ISO.");
    expect(texts[0].content).toContain(`http://localhost:3000/b/${res.token}`);
    expect(texts[0].content).toMatch(/Reply STOP to opt out\.$/);
  });

  it("texts the agent at their settings number", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const now = Date.parse(start) - 15 * 60_000;
    await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:${host.id}:15`), ctx, { now });
    expect(texts[0].to).toBe("+13105550199");
    expect(texts[0].content).toContain("with Pat Smith (Acme ISO)");
    expect(texts[0].content).toContain("Phone: (212) 555-0142.");
  });

  it("skips invalid and opted-out numbers, and honours STOP and START replies", async () => {
    const { team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start, phone: "555-0142" });
    const now = Date.parse(start) - 60 * 60_000;
    const j = await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`);
    expect(await handleSmsSend(j, ctx, { now })).toEqual({ result: { skipped: "invalid_phone" } });

    await sql`update app.bookings set invitee_phone = '212-555-0142' where id = ${res.bookingId}`;
    const headers = new Headers({ "sb-signing-secret": SECRET });
    const stop = await handleInboundSms(headers, JSON.stringify({ number: "+12125550142", from_number: "+12125550142", content: "STOP", is_outbound: false }), { secret: SECRET });
    expect(stop).toEqual({ status: 200, body: { ok: true, action: "opted_out" } });
    const [row] = await sql`select phone_e164, keyword from app.sms_opt_outs`;
    expect(row).toEqual({ phone_e164: "+12125550142", keyword: "STOP" });
    expect(await handleSmsSend(j, ctx, { now })).toEqual({ result: { skipped: "opted_out" } });
    expect(texts).toHaveLength(0);

    const start2 = await handleInboundSms(headers, JSON.stringify({ number: "+12125550142", content: "start" }), { secret: SECRET });
    expect(start2.body.action).toBe("opted_in");
    expect(await sql`select 1 from app.sms_opt_outs`).toHaveLength(0);
    expect(await handleSmsSend(j, ctx, { now })).toMatchObject({ result: { sent: true } });
  });

  it("skips cancelled bookings and texts nobody when SendBlue is not configured", async () => {
    const { team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const j = await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`);
    setSmsTransport(null);
    const out = await handleSmsSend(j, ctx, { now: Date.parse(start) - 60 * 60_000 });
    expect(out).toEqual({ result: { sent: false, providerId: null, status: null } });
    await cancelByInvitee(res.token, undefined);
    expect(await handleSmsSend(j, ctx, { now: Date.parse(start) - 60 * 60_000 })).toEqual({ result: { skipped: "status_cancelled" } });
  });
});

describe("reminder settings changed after booking", () => {
  it("stops queued merchant texts when SMS is turned off on the page", async () => {
    const { team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const j = await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`);
    await sql`update app.event_types set merchant_reminder_channels = '{email}' where id = ${ev.id}`;
    expect(await handleSmsSend(j, ctx, { now: Date.parse(start) - 60 * 60_000 })).toEqual({ result: { skipped: "channel_disabled" } });
    expect(texts).toHaveLength(0);
  });

  it("stops queued reminders at a time that was removed, on every channel", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    await sql`update app.event_types set reminder_offsets_min = '{1440}', agent_reminder_offsets_min = '{60}' where id = ${ev.id}`;
    const at60 = Date.parse(start) - 60 * 60_000;
    const at15 = Date.parse(start) - 15 * 60_000;
    expect(await handleEmailSend(await job(res.bookingId, "email_send", `${res.bookingId}:reminder:60`), ctx, { now: at60 })).toEqual({ result: { skipped: "offset_disabled" } });
    expect(await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`), ctx, { now: at60 })).toEqual({ result: { skipped: "offset_disabled" } });
    expect(await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:${host.id}:15`), ctx, { now: at15 })).toEqual({ result: { skipped: "offset_disabled" } });
    const slack = fakeSlack();
    expect(await handleSlackDm(await job(res.bookingId, "slack_dm_send", `${res.bookingId}:slack_dm:${host.id}:15`), ctx, { client: slack.client, now: at15 })).toEqual({
      result: { skipped: "offset_disabled" },
    });
    // The 60 minute agent reminder is still enabled and goes out.
    expect(await handleEmailSend(await job(res.bookingId, "email_send", `${res.bookingId}:host_reminder:${host.id}:60`), ctx, { now: at60 })).toMatchObject({ result: { sent: true } });
    expect(texts).toHaveLength(0);
    expect(slack.calls).toHaveLength(0);
    expect(emails).toHaveLength(1);
  });

  it("stops queued agent reminders when their channel is turned off", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    await sql`update app.event_types set agent_reminder_channels = '{}', merchant_reminder_channels = '{sms}' where id = ${ev.id}`;
    const at15 = Date.parse(start) - 15 * 60_000;
    const slack = fakeSlack();
    expect(await handleSlackDm(await job(res.bookingId, "slack_dm_send", `${res.bookingId}:slack_dm:${host.id}:15`), ctx, { client: slack.client, now: at15 })).toEqual({
      result: { skipped: "channel_disabled" },
    });
    expect(await handleEmailSend(await job(res.bookingId, "email_send", `${res.bookingId}:host_reminder:${host.id}:15`), ctx, { now: at15 })).toEqual({ result: { skipped: "channel_disabled" } });
    expect(await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:${host.id}:15`), ctx, { now: at15 })).toEqual({ result: { skipped: "channel_disabled" } });
    expect(await handleEmailSend(await job(res.bookingId, "email_send", `${res.bookingId}:reminder:60`), ctx, { now: Date.parse(start) - 60 * 60_000 })).toEqual({
      result: { skipped: "channel_disabled" },
    });
    expect(slack.calls).toHaveLength(0);
    expect(texts).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });
});

describe("overdue reminders", () => {
  it("drops stale reminders after a backlog instead of sending them all at once", async () => {
    const { host, team, ev } = await teamSetup();
    await sql`update app.event_types set agent_reminder_offsets_min = '{1440,15}' where id = ${ev.id}`;
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const now = Date.parse(start) - 20 * 60_000;
    expect(await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:1440`), ctx, { now })).toEqual({ result: { skipped: "stale" } });
    expect(await handleSmsSend(await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`), ctx, { now })).toEqual({ result: { skipped: "stale" } });
    const slack = fakeSlack();
    expect(await handleSlackDm(await job(res.bookingId, "slack_dm_send", `${res.bookingId}:slack_dm:${host.id}:1440`), ctx, { client: slack.client, now })).toEqual({
      result: { skipped: "stale" },
    });
    expect(texts).toHaveLength(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("states the time actually left when a reminder runs late but not stale", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const now = Date.parse(start) - 35 * 60_000; // the 60 minute reminder, 25 minutes late
    const slack = fakeSlack();
    expect(await handleSlackDm(await job(res.bookingId, "slack_dm_send", `${res.bookingId}:slack_dm:${host.id}:60`), ctx, { client: slack.client, now })).toMatchObject({
      result: { sent: true },
    });
    const post = slack.calls.find((c) => c.method === "chat.postMessage")!;
    expect(String(post.body.text)).toContain("*Reminder: Funding consultation starts in 35 minutes*");
    await handleEmailSend(await job(res.bookingId, "email_send", `${res.bookingId}:host_reminder:${host.id}:60`), ctx, { now });
    expect(emails[0].html).toContain("Your meeting starts in 35 minutes");
  });
});

describe("merchant SMS consent", () => {
  it("does not text a merchant who did not check the consent box", async () => {
    const { team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start, smsConsent: false });
    const [b] = await sql`select sms_consent_at from app.bookings where id = ${res.bookingId}`;
    expect(b.sms_consent_at).toBeNull();
    const j = await job(res.bookingId, "sms_send", `${res.bookingId}:sms:invitee:60`);
    expect(await handleSmsSend(j, ctx, { now: Date.parse(start) - 60 * 60_000 })).toEqual({ result: { skipped: "no_consent" } });
    expect(texts).toHaveLength(0);
  });

  it("records consent only with a phone number and keeps it across a reschedule", async () => {
    const { team, ev } = await teamSetup();
    const noPhone = await book(team, ev, { phone: null, smsConsent: true, start: futureSlot(3) });
    const [a] = await sql`select sms_consent_at from app.bookings where id = ${noPhone.bookingId}`;
    expect(a.sms_consent_at).toBeNull();

    const withPhone = await book(team, ev, { smsConsent: true, start: futureSlot(4) });
    const [b] = await sql<{ sms_consent_at: Date | null }[]>`select sms_consent_at from app.bookings where id = ${withPhone.bookingId}`;
    expect(b.sms_consent_at).toBeInstanceOf(Date);
    const moved = await rescheduleByInvitee(withPhone.token, { start: futureSlot(5) });
    const [c] = await sql<{ sms_consent_at: Date | null }[]>`select sms_consent_at from app.bookings where id = ${moved.bookingId}`;
    expect(c.sms_consent_at?.getTime()).toBe(b.sms_consent_at!.getTime());
  });

  it("tells the public form when the page sends merchant texts", async () => {
    const { team, ev } = await teamSetup({ channels: false });
    const load = async () => {
      const loaded = await loadPublicEventType(sql, { kind: "team", slug: team.slug }, ev.slug, "en");
      return (await toPublicEventType(sql, loaded!)).smsReminders;
    };
    expect(await load()).toBe(false);
    await sql`update app.event_types set merchant_reminder_channels = '{email,sms}' where id = ${ev.id}`;
    expect(await load()).toBe(true);
  });
});

describe("reminder schema", () => {
  it("rejects unknown channels and out-of-range agent offsets", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    await expect(sql`update app.event_types set merchant_reminder_channels = '{slack}' where id = ${ev.id}`).rejects.toThrow();
    await expect(sql`update app.event_types set agent_reminder_channels = '{fax}' where id = ${ev.id}`).rejects.toThrow();
    await expect(sql`update app.event_types set agent_reminder_offsets_min = '{0}' where id = ${ev.id}`).rejects.toThrow();
    await expect(sql`update app.user_settings set sms_phone = '212-555-0142' where user_id = ${host.id}`).rejects.toThrow();
  });

  it("shows the opt-out list to admins only", async () => {
    const agent = await makeUser(sql);
    const admin = await makeUser(sql, { role: "admin" });
    await sql`insert into app.sms_opt_outs (phone_e164, keyword) values ('+12125550142', 'STOP')`;
    expect(await withUser(agent.id, (tx) => tx`select phone_e164 from app.sms_opt_outs`)).toHaveLength(0);
    expect(await withUser(admin.id, (tx) => tx`select phone_e164 from app.sms_opt_outs`)).toHaveLength(1);
    await expect(withUser(admin.id, (tx) => tx`insert into app.sms_opt_outs (phone_e164, keyword) values ('+12125550143', 'STOP')`)).rejects.toThrow();
  });
});

describe("inbound SMS webhook", () => {
  it("rejects missing configuration and wrong secrets", async () => {
    const body = JSON.stringify({ number: "+12125550142", content: "STOP" });
    expect((await handleInboundSms(new Headers(), body, { secret: "" })).status).toBe(503);
    expect((await handleInboundSms(new Headers({ "sb-signing-secret": "wrong-secret-000000" }), body, { secret: SECRET })).status).toBe(401);
    expect((await handleInboundSms(new Headers({ "sb-signing-secret": SECRET }), "not json", { secret: SECRET })).status).toBe(400);
    expect(await sql`select 1 from app.sms_opt_outs`).toHaveLength(0);
  });

  it("ignores ordinary replies and outbound echoes", async () => {
    const h = new Headers({ "sb-signing-secret": SECRET });
    expect((await handleInboundSms(h, JSON.stringify({ number: "+12125550142", content: "See you then" }), { secret: SECRET })).body.action).toBe("ignored");
    expect((await handleInboundSms(h, JSON.stringify({ number: "+12125550142", content: "STOP", is_outbound: true }), { secret: SECRET })).body.action).toBe(
      "ignored_outbound",
    );
    expect(await sql`select 1 from app.sms_opt_outs`).toHaveLength(0);
  });
});

function fakeSlack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const raw = String(init.body ?? "");
    const body = raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, body });
    const json = method === "users.lookupByEmail" ? { ok: true, user: { id: "UHOST001" } } : { ok: true, ts: "1.2" };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, client: () => createSlackClient({ token: "xoxb-test", fetch: fetchImpl }) };
}

describe("slack_dm_send", () => {
  it("DMs the host with time, merchant, phone, answers, meeting link and partner", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    await sql`update app.bookings set online_meeting_url = 'https://teams.example/join' where id = ${res.bookingId}`;
    const slack = fakeSlack();
    const j = await job(res.bookingId, "slack_dm_send", `${res.bookingId}:slack_dm:${host.id}:15`);
    const out = await handleSlackDm(j, ctx, { client: slack.client, now: Date.parse(start) - 15 * 60_000 });
    expect(out).toEqual({ result: { sent: true, slackUserId: "UHOST001" } });
    const post = slack.calls.find((c) => c.method === "chat.postMessage")!;
    expect(post.body.channel).toBe("UHOST001");
    const text = String(post.body.text);
    expect(text).toContain("*Partner:* Acme ISO");
    expect(text).toContain("*Merchant:* Pat Smith");
    expect(text).toContain("*Phone:* (212) 555-0142");
    expect(text).toContain("*Company:* Pat's Pizza");
    expect(text).toContain("<https://teams.example/join|Join Microsoft Teams meeting>");
    expect(text).toMatch(/Pacific/);
    const [cached] = await sql`select slack_user_id from app.slack_identities where user_id = ${host.id}`;
    expect(cached.slack_user_id).toBe("UHOST001");
  });

  it("skips without a Slack token and for hosts no longer assigned", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const j = await job(res.bookingId, "slack_dm_send", `${res.bookingId}:slack_dm:${host.id}:15`);
    const now = Date.parse(start) - 15 * 60_000;
    const notConfigured = () => {
      throw new SlackNotConfiguredError();
    };
    expect(await handleSlackDm(j, ctx, { client: notConfigured, now })).toEqual({ result: { skipped: "slack_not_configured" } });
    await sql`update app.booking_hosts set active = false where booking_id = ${res.bookingId}`;
    expect(await handleSlackDm(j, ctx, { client: fakeSlack().client, now })).toEqual({ result: { skipped: "not_a_host" } });
  });
});

describe("agent email reminders and partner name in merchant email", () => {
  it("emails the host a reminder with the partner and the merchant's answers", async () => {
    const { host, team, ev } = await teamSetup();
    const start = futureSlot(3);
    const res = await book(team, ev, { start });
    const j = await job(res.bookingId, "email_send", `${res.bookingId}:host_reminder:${host.id}:15`);
    const out = await handleEmailSend(j, ctx, { now: Date.parse(start) - 15 * 60_000 });
    expect(out).toMatchObject({ result: { sent: true } });
    expect(emails[0].to).toBe(host.email);
    expect(emails[0].subject).toMatch(/^Reminder: Funding consultation with Pat Smith \(Acme ISO\) at /);
    expect(emails[0].text).toContain("Pat's Pizza");
    expect(emails[0].text).toContain("(212) 555-0142");
  });

  it("includes the partner name in the merchant confirmation for team pages", async () => {
    const { team, ev } = await teamSetup({ channels: false, partner: "Summit Funding Group" });
    const res = await book(team, ev);
    await handleEmailSend(await job(res.bookingId, "email_send", `${res.bookingId}:confirmed`), ctx);
    expect(emails[0].text).toMatch(/Partner\s+Summit Funding Group/);
    expect(emails[0].attachments?.[0].content).toContain("Summit Funding Group");
  });
});
