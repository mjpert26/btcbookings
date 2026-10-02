import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { withUser, type Sql } from "@/server/db/client";
import { cancelBookingAsHost } from "@/server/booking/host-actions";

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

async function seedBooking(hostId: string) {
  const [et] = await sql<{ id: string }[]>`insert into app.event_types (owner_user_id, slug, name) values (${hostId}, 'intro', 'Intro') returning id`;
  const [b] = await sql<{ id: string }[]>`
    insert into app.bookings (event_type_id, start_at, end_at, invitee_name, invitee_email, invitee_timezone, location_type, manage_token_hash)
    values (${et.id}, now() + interval '1 day', now() + interval '1 day 30 minutes', 'Pat', 'pat@example.com', 'UTC', 'teams', ${randomUUID()})
    returning id
  `;
  await sql`
    insert into app.booking_hosts (booking_id, user_id, blocked_range, graph_event_id)
    values (${b.id}, ${hostId}, tstzrange(now() + interval '1 day', now() + interval '1 day 30 minutes'), 'AAMk1')
  `;
  return { eventTypeId: et.id, bookingId: b.id };
}

describe("cancelBookingAsHost", () => {
  it("cancels, deactivates hosts and enqueues the Outlook delete and invitee email", async () => {
    const host = await makeUser(sql);
    const { bookingId } = await seedBooking(host.id);
    const res = await cancelBookingAsHost(host.id, bookingId, "Client asked to move");
    expect(res).toEqual({ ok: true, alreadyCancelled: false });

    const [b] = await sql`select status, cancelled_by, cancel_reason from app.bookings where id = ${bookingId}`;
    expect(b).toMatchObject({ status: "cancelled", cancelled_by: "host", cancel_reason: "Client asked to move" });
    const [h] = await sql`select active from app.booking_hosts where booking_id = ${bookingId}`;
    expect(h.active).toBe(false);
    const jobs = await sql<{ kind: string; payload: Record<string, unknown> }[]>`select kind, payload from app.jobs where booking_id = ${bookingId} order by kind`;
    expect(jobs.map((j) => j.kind)).toEqual(["email_send", "graph_event_delete"]);
    expect(jobs[1].payload).toMatchObject({ bookingId, userId: host.id, graphEventId: "AAMk1" });
    expect(jobs[0].payload).toMatchObject({ template: "booking_cancelled", recipient: "invitee" });
    const audits = await sql`select action from app.audit_log where entity_id = ${bookingId}`;
    expect(audits).toHaveLength(1);
  });

  it("is idempotent when repeated", async () => {
    const host = await makeUser(sql);
    const { bookingId } = await seedBooking(host.id);
    await cancelBookingAsHost(host.id, bookingId, null);
    const again = await cancelBookingAsHost(host.id, bookingId, null);
    expect(again).toEqual({ ok: true, alreadyCancelled: true });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.jobs where booking_id = ${bookingId}`;
    expect(n).toBe(2);
  });

  it("does nothing for a user who cannot read the booking", async () => {
    const host = await makeUser(sql);
    const stranger = await makeUser(sql);
    const { bookingId } = await seedBooking(host.id);
    expect(await cancelBookingAsHost(stranger.id, bookingId, null)).toEqual({ ok: false, reason: "not_found" });
    const [b] = await sql`select status from app.bookings where id = ${bookingId}`;
    expect(b.status).toBe("confirmed");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.jobs`;
    expect(n).toBe(0);
  });
});

describe("RLS insert pattern used by the internal UI", () => {
  // The SELECT policies on event_types and availability_schedules call security-definer
  // functions that re-read the table, which cannot see a row inserted by the same
  // statement. INSERT ... RETURNING therefore fails; the UI generates ids instead.
  it("rejects RETURNING but accepts an app-generated id", async () => {
    const u = await makeUser(sql);
    await expect(
      withUser(u.id, (tx) => tx`insert into app.event_types (owner_user_id, slug, name) values (${u.id}, 'a', 'A') returning id`),
    ).rejects.toThrow(/row-level security/);
    const id = randomUUID();
    await withUser(u.id, (tx) => tx`insert into app.event_types (id, owner_user_id, slug, name) values (${id}, ${u.id}, 'a', 'A')`);
    const rows = await withUser(u.id, (tx) => tx`select id from app.event_types where id = ${id}`);
    expect(rows).toHaveLength(1);
  });
});
