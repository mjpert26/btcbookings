import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { futureSlot, invitee, makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import { makeBooking } from "../helpers/booking-fixtures";
import { withUser, type Sql } from "@/server/db/client";
import { getAvailableSlots } from "@/server/booking/slots";
import { createBooking } from "@/server/booking/create";
import { SlotTakenError, type BookingInput } from "@/server/booking/types";
import { bookingsInsideBlocks, createTimeOff, deleteTimeOff, listTimeOff, overlappingBookings } from "@/server/time-off";
import { TIME_OFF_MAX_FUTURE, type TimeOffInput } from "@/lib/time-off";

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

const NY = "America/New_York";
const HOUR = 3_600_000;

/** The New York date of a futureSlot() start, for time-off form input. */
function nyDate(isoStart: string): string {
  return DateTime.fromISO(isoStart, { zone: NY }).toISODate()!;
}

/** A time window from 09:00 to 12:00 New York time on the date of `start`. */
function morningOff(start: string, note?: string): TimeOffInput {
  return { allDay: false, startDate: nyDate(start), startTime: "09:00", endTime: "12:00", note };
}

async function addOwn(userId: string, input: TimeOffInput) {
  const res = await withUser(userId, (tx) => createTimeOff(tx, { actorUserId: userId, userId, input }));
  if (!res.ok) throw new Error(`createTimeOff failed: ${res.message} ${JSON.stringify(res.errors)}`);
  return res;
}

function bookingInput(owner: BookingInput["owner"], eventSlug: string, start: string): BookingInput {
  return { owner, eventSlug, language: "en", start, durationMin: 30, ...invitee() };
}

async function slotStarts(owner: BookingInput["owner"], eventSlug: string, start: string): Promise<string[]> {
  const day = DateTime.fromISO(start, { zone: "UTC" }).startOf("day");
  const slots = await getAvailableSlots(owner, eventSlug, "en", { from: day.toJSDate(), to: day.plus({ days: 1 }).toJSDate() });
  return slots.map((s) => s.start);
}

describe("time off: availability", () => {
  it("removes slots on a personal page, rejects a booking in the window, and restores both when deleted", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const owner = { kind: "user" as const, slug: host.slug };
    // 15:00 UTC is 10:00 in New York (EST), inside the 09:00-12:00 window.
    const blocked = futureSlot(3, 15);
    const open = futureSlot(3, 18);
    expect(await slotStarts(owner, ev.slug, blocked)).toContain(blocked);

    const res = await addOwn(host.id, morningOff(blocked));
    const starts = await slotStarts(owner, ev.slug, blocked);
    expect(starts).not.toContain(blocked);
    expect(starts).toContain(open);
    const blockStart = res.block.startsAt.getTime();
    const blockEnd = res.block.endsAt.getTime();
    expect(blockEnd - blockStart).toBe(3 * HOUR);
    expect(starts.every((s) => Date.parse(s) + 30 * 60_000 <= blockStart || Date.parse(s) >= blockEnd)).toBe(true);

    await expect(createBooking(bookingInput(owner, ev.slug, blocked))).rejects.toBeInstanceOf(SlotTakenError);

    const removed = await withUser(host.id, (tx) => deleteTimeOff(tx, { actorUserId: host.id, id: res.block.id, userId: host.id }));
    expect(removed).toBe(true);
    expect(await slotStarts(owner, ev.slug, blocked)).toContain(blocked);
    const booked = await createBooking(bookingInput(owner, ev.slug, blocked));
    expect(booked.bookingId).toBeTruthy();
  });

  it("blocks every page the user hosts, including one on another schedule", async () => {
    const host = await makeHost(sql);
    const [other] = await sql<{ id: string }[]>`
      insert into app.availability_schedules (owner_user_id, name, timezone, weekly_rules, is_default)
      values (${host.id}, 'Evenings', 'UTC', ${sql.json(Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "00:00", end: "24:00" }]])) as never)}, false)
      returning id
    `;
    const ev = await makeEvent(sql, { userId: host.id }, { slug: "other-schedule" });
    await sql`update app.event_types set schedule_id = ${other.id} where id = ${ev.id}`;
    const blocked = futureSlot(3, 15);
    await addOwn(host.id, { allDay: true, startDate: nyDate(blocked) });
    const starts = await slotStarts({ kind: "user", slug: host.slug }, ev.slug, blocked);
    expect(starts).not.toContain(blocked);
  });

  it("skips a round-robin host on time off and still offers the other host", async () => {
    const off = await makeHost(sql, { name: "Off" });
    const on = await makeHost(sql, { name: "On" });
    const team = await makeTeam(sql, [off.id, on.id]);
    const ev = await makeEvent(sql, { teamId: team.id }, { mode: "round_robin" });
    const owner = { kind: "team" as const, slug: team.slug };
    const blocked = futureSlot(3, 15);
    await addOwn(off.id, morningOff(blocked));

    expect(await slotStarts(owner, ev.slug, blocked)).toContain(blocked);
    const first = await createBooking(bookingInput(owner, ev.slug, blocked));
    const hosts = await sql<{ user_id: string }[]>`select user_id from app.booking_hosts where booking_id = ${first.bookingId}`;
    expect(hosts.map((h) => h.user_id)).toEqual([on.id]);
    // The only free host is now booked, and the host on time off is never chosen.
    expect(await slotStarts(owner, ev.slug, blocked)).not.toContain(blocked);
    await expect(createBooking(bookingInput(owner, ev.slug, blocked))).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("removes collective slots when one required host is on time off", async () => {
    const a = await makeHost(sql);
    const b = await makeHost(sql);
    const team = await makeTeam(sql, [a.id, b.id]);
    const ev = await makeEvent(sql, { teamId: team.id }, { mode: "collective" });
    const owner = { kind: "team" as const, slug: team.slug };
    const blocked = futureSlot(3, 15);
    const open = futureSlot(3, 18);
    await addOwn(b.id, morningOff(blocked));
    const starts = await slotStarts(owner, ev.slug, blocked);
    expect(starts).not.toContain(blocked);
    expect(starts).toContain(open);
    await expect(createBooking(bookingInput(owner, ev.slug, blocked))).rejects.toBeInstanceOf(SlotTakenError);
  });
});

describe("time off: create, delete and audit", () => {
  it("writes create and delete audit entries without the note", async () => {
    const host = await makeHost(sql);
    const blocked = futureSlot(3, 15);
    const res = await addOwn(host.id, morningOff(blocked, "Dentist"));
    expect(res.block.note).toBe("Dentist");
    expect(res.block.timezone).toBe(NY);
    await withUser(host.id, (tx) => deleteTimeOff(tx, { actorUserId: host.id, id: res.block.id, userId: host.id }));

    const rows = await sql<{ action: string; entity_type: string; entity_id: string; actor_user_id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; via: string }[]>`
      select action, entity_type, entity_id, actor_user_id, before, after, via from app.audit_log
      where entity_type = 'time_off' order by created_at, action
    `;
    expect(rows.map((r) => r.action)).toEqual(["time_off.create", "time_off.delete"]);
    const expected = {
      user_id: host.id,
      starts_at: res.block.startsAt.toISOString(),
      ends_at: res.block.endsAt.toISOString(),
      all_day: false,
    };
    expect(rows[0]).toMatchObject({ entity_id: res.block.id, actor_user_id: host.id, before: null, after: expected, via: "web" });
    expect(rows[1]).toMatchObject({ entity_id: res.block.id, before: expected, after: null, via: "web" });
    expect(JSON.stringify(rows)).not.toContain("Dentist");
  });

  it("validates input and refuses more than the limit of upcoming blocks", async () => {
    const host = await makeHost(sql);
    const bad = await withUser(host.id, (tx) =>
      createTimeOff(tx, { actorUserId: host.id, userId: host.id, input: { allDay: true, startDate: "2026-12-09", endDate: "2026-12-07" } }),
    );
    expect(bad).toMatchObject({ ok: false, errors: { endDate: expect.any(String) } });

    const base = DateTime.utc().plus({ days: 5 });
    await sql`
      insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone, created_by)
      select ${host.id}, ${base.toJSDate()}::timestamptz + make_interval(hours => g), ${base.toJSDate()}::timestamptz + make_interval(hours => g, mins => 30),
             false, 'America/New_York', ${host.id}
      from generate_series(1, ${TIME_OFF_MAX_FUTURE}) g
    `;
    // A block that has already ended does not count toward the limit.
    await sql`
      insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone)
      values (${host.id}, now() - interval '3 days', now() - interval '2 days', true, 'America/New_York')
    `;
    const over = await withUser(host.id, (tx) =>
      createTimeOff(tx, { actorUserId: host.id, userId: host.id, input: { allDay: true, startDate: base.plus({ days: 30 }).toISODate()! } }),
    );
    expect(over.ok).toBe(false);
    expect(!over.ok && over.message).toMatch(/already 100 upcoming/);
  });

  it("lets an admin add time off for another user in that user's zone, but not for an inactive user", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const host = await makeHost(sql, { timezone: "America/Los_Angeles" });
    const res = await withUser(admin.id, (tx) =>
      createTimeOff(tx, { actorUserId: admin.id, userId: host.id, input: { allDay: true, startDate: nyDate(futureSlot(4)) } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.block).toMatchObject({ userId: host.id, createdBy: admin.id, timezone: "America/Los_Angeles" });
    expect(DateTime.fromJSDate(res.block.startsAt, { zone: "America/Los_Angeles" }).toFormat("HH:mm")).toBe("00:00");

    const gone = await makeHost(sql);
    await sql`update app.users set is_active = false where id = ${gone.id}`;
    const refused = await withUser(admin.id, (tx) =>
      createTimeOff(tx, { actorUserId: admin.id, userId: gone.id, input: { allDay: true, startDate: nyDate(futureSlot(4)) } }),
    );
    expect(refused.ok).toBe(false);
  });

  it("lists only blocks that have not ended", async () => {
    const host = await makeHost(sql);
    await sql`
      insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone)
      values (${host.id}, now() - interval '3 days', now() - interval '2 days', true, 'America/New_York'),
             (${host.id}, now() - interval '1 hour', now() + interval '1 hour', false, 'America/New_York'),
             (${host.id}, now() + interval '2 days', now() + interval '3 days', true, 'America/New_York')
    `;
    const list = await withUser(host.id, (tx) => listTimeOff(tx, { userId: host.id }));
    expect(list).toHaveLength(2);
    expect(list[0].startsAt.getTime()).toBeLessThan(list[1].startsAt.getTime());
  });
});

describe("time off: overlapping bookings warning", () => {
  it("returns only the user's confirmed upcoming bookings inside the block, with time and invitee name", async () => {
    const host = await makeHost(sql);
    const other = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const otherEv = await makeEvent(sql, { userId: other.id });
    const day = DateTime.fromISO(futureSlot(3, 15), { zone: NY }).set({ hour: 0, minute: 0 });
    const at = (h: number, m = 0) => day.set({ hour: h, minute: m }).toJSDate();

    const inside = await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(10), end: at(10, 30), inviteeName: "Inside Person" });
    // Starts before the block and ends inside it.
    const edge = await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(8, 45), end: at(9, 15), inviteeName: "Edge Person" });
    await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(11), end: at(11, 30), status: "cancelled", inviteeName: "Cancelled" });
    await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(12), end: at(12, 30), inviteeName: "After Block" });
    await makeBooking(sql, { eventTypeId: otherEv.id, hosts: [{ userId: other.id }], start: at(10), end: at(10, 30), inviteeName: "Other Host" });

    const res = await addOwn(host.id, { allDay: false, startDate: day.toISODate()!, startTime: "09:00", endTime: "12:00" });
    expect(res.overlapping.map((b) => b.bookingId)).toEqual([edge, inside]);
    expect(res.overlapping[1]).toEqual({ bookingId: inside, startAt: at(10), endAt: at(10, 30), inviteeName: "Inside Person" });
    expect(Object.keys(res.overlapping[0]).sort()).toEqual(["bookingId", "endAt", "inviteeName", "startAt"]);

    // Existing bookings are not changed.
    const [row] = await sql<{ status: string }[]>`select status from app.bookings where id = ${inside}`;
    expect(row.status).toBe("confirmed");

    // Past bookings are not listed.
    const past = await withUser(host.id, (tx) =>
      overlappingBookings(tx, host.id, { startsAt: res.block.startsAt, endsAt: res.block.endsAt }, new Date(at(10, 30).getTime() + 1)),
    );
    expect(past).toEqual([]);
  });

  it("groups bookings by block and applies the limit per block, not across the span between blocks", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const day = DateTime.fromISO(futureSlot(3, 15), { zone: NY }).set({ hour: 0, minute: 0 });
    const at = (d: number, h: number, m = 0) => day.plus({ days: d }).set({ hour: h, minute: m }).toJSDate();

    const early = await addOwn(host.id, { allDay: false, startDate: day.toISODate()!, startTime: "09:00", endTime: "10:00" });
    const empty = await addOwn(host.id, { allDay: false, startDate: day.plus({ days: 1 }).toISODate()!, startTime: "09:00", endTime: "10:00" });
    const late = await addOwn(host.id, { allDay: false, startDate: day.plus({ days: 2 }).toISODate()!, startTime: "09:00", endTime: "10:00" });

    const inEarly = await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(0, 9), end: at(0, 9, 30), inviteeName: "Early" });
    // A second booking in the first block is cut by the per-block limit of 1.
    await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(0, 9, 30), end: at(0, 10), inviteeName: "Early 2" });
    // Bookings between the blocks must not count toward any block's limit.
    for (const h of [12, 13, 14]) {
      await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(0, h), end: at(0, h, 30), inviteeName: "Between" });
    }
    const inLate = await makeBooking(sql, { eventTypeId: ev.id, hosts: [{ userId: host.id }], start: at(2, 9, 30), end: at(2, 10), inviteeName: "Late" });

    const blocks = [early.block, empty.block, late.block];
    const res = await withUser(host.id, (tx) => bookingsInsideBlocks(tx, host.id, blocks, new Date(), 1));
    expect(Object.keys(res).sort()).toEqual([early.block.id, late.block.id].sort());
    expect(res[early.block.id].map((b) => b.bookingId)).toEqual([inEarly]);
    expect(res[late.block.id]).toEqual([{ bookingId: inLate, startAt: at(2, 9, 30), endAt: at(2, 10), inviteeName: "Late" }]);
    expect(res[empty.block.id]).toBeUndefined();
  });
});

describe("time off: row level security", () => {
  async function insertAs(actorId: string, userId: string, createdBy: string = actorId) {
    return withUser(actorId, (tx) => tx`
      insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone, created_by)
      values (${userId}, now() + interval '1 day', now() + interval '2 days', true, 'America/New_York', ${createdBy})
    `);
  }
  async function seed(userId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone, note, created_by)
      values (${userId}, now() + interval '1 day', now() + interval '2 days', true, 'America/New_York', 'private', ${userId})
      returning id
    `;
    return row.id;
  }

  it("lets an agent read, add and delete only their own blocks", async () => {
    const a = await makeUser(sql);
    const b = await makeUser(sql);
    const aId = await seed(a.id);
    const bId = await seed(b.id);
    expect((await withUser(a.id, (tx) => tx`select id from app.time_off`)).map((r) => r.id)).toEqual([aId]);

    await insertAs(a.id, a.id);
    await expect(insertAs(a.id, b.id)).rejects.toThrow(/row-level security/);
    await expect(insertAs(a.id, a.id, b.id)).rejects.toThrow(/row-level security/);

    const deletedOther = await withUser(a.id, (tx) => tx`delete from app.time_off where id = ${bId} returning id`);
    expect(deletedOther).toHaveLength(0);
    expect(await withUser(a.id, (tx) => deleteTimeOff(tx, { actorUserId: a.id, id: bId }))).toBe(false);
    expect(await withUser(a.id, (tx) => deleteTimeOff(tx, { actorUserId: a.id, id: aId, userId: a.id }))).toBe(true);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.time_off where id = ${bId}`;
    expect(n).toBe(1);
  });

  it("does not allow updates; blocks are deleted and added again", async () => {
    const a = await makeUser(sql);
    const id = await seed(a.id);
    await expect(withUser(a.id, (tx) => tx`update app.time_off set note = 'changed' where id = ${id}`)).rejects.toThrow(/permission denied/);
  });

  it("lets an admin read, add and delete anyone's blocks", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const a = await makeUser(sql);
    const aId = await seed(a.id);
    expect(await withUser(admin.id, (tx) => tx`select id from app.time_off`)).toHaveLength(1);
    await insertAs(admin.id, a.id);
    await expect(insertAs(admin.id, a.id, a.id)).rejects.toThrow(/row-level security/);
    expect(await withUser(admin.id, (tx) => deleteTimeOff(tx, { actorUserId: admin.id, id: aId }))).toBe(true);
    expect(await withUser(admin.id, (tx) => tx`select id from app.time_off`)).toHaveLength(1);
  });

  it("lets a manager read every block but not add or delete others' blocks", async () => {
    const manager = await makeUser(sql, { role: "manager" });
    const a = await makeUser(sql);
    const aId = await seed(a.id);
    expect(await withUser(manager.id, (tx) => tx`select id from app.time_off`)).toHaveLength(1);
    await expect(insertAs(manager.id, a.id)).rejects.toThrow(/row-level security/);
    expect(await withUser(manager.id, (tx) => tx`delete from app.time_off where id = ${aId} returning id`)).toHaveLength(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.time_off`;
    expect(n).toBe(1);
  });

  it("gives a session without a user nothing", async () => {
    const a = await makeUser(sql);
    await seed(a.id);
    const rows = await sql.begin(async (tx) => {
      // Claims with no user id, as for a request with no signed-in employee.
      await tx`select set_config('request.jwt.claims', '{}', true)`;
      await tx`set local role app_user`;
      return tx`select id from app.time_off`;
    });
    expect(rows).toHaveLength(0);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', '{}', true)`;
        await tx`set local role app_user`;
        await tx`
          insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone, created_by)
          values (${a.id}, now() + interval '1 day', now() + interval '2 days', true, 'UTC', ${a.id})
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("enforces the table's range and note checks", async () => {
    const a = await makeUser(sql);
    await expect(
      sql`insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone) values (${a.id}, now() + interval '2 days', now() + interval '1 day', true, 'UTC')`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone) values (${a.id}, now(), now() + interval '367 days', true, 'UTC')`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into app.time_off (user_id, starts_at, ends_at, all_day, timezone, note) values (${a.id}, now(), now() + interval '1 day', true, 'UTC', ${"x".repeat(201)})`,
    ).rejects.toThrow(/check constraint/);
  });
});
