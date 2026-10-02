import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { withUser, type Sql } from "@/server/db/client";

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

describe("row level security", () => {
  it("enables RLS on every app table", async () => {
    const rows = await sql`select tablename from pg_tables where schemaname = 'app' and not rowsecurity`;
    expect(rows).toEqual([]);
  });

  it("never exposes token columns to app_user", async () => {
    const u = await makeUser(sql);
    await expect(
      withUser(u.id, (tx) => tx`select refresh_token_enc from app.calendar_connections where user_id = ${u.id}`),
    ).rejects.toThrow(/permission denied/);
    const ok = await withUser(u.id, (tx) => tx`select status from app.calendar_connections where user_id = ${u.id}`);
    expect(ok).toHaveLength(1);
  });

  it("isolates event types and bookings between users", async () => {
    const a = await makeUser(sql);
    const b = await makeUser(sql);
    const [et] = await sql`insert into app.event_types (owner_user_id, slug, name) values (${a.id}, 'intro', 'Intro') returning id`;
    expect(await withUser(a.id, (tx) => tx`select id from app.event_types`)).toHaveLength(1);
    expect(await withUser(b.id, (tx) => tx`select id from app.event_types`)).toHaveLength(0);
    const updated = await withUser(b.id, (tx) => tx`update app.event_types set name = 'x' where id = ${et.id} returning id`);
    expect(updated).toHaveLength(0);
    await expect(
      withUser(b.id, (tx) => tx`insert into app.event_types (owner_user_id, slug, name) values (${a.id}, 'evil', 'Evil')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("restricts Salesforce settings to admins", async () => {
    const user = await makeUser(sql);
    const admin = await makeUser(sql, { role: "admin" });
    const [et] = await sql`insert into app.event_types (owner_user_id, slug, name) values (${user.id}, 'intro', 'Intro') returning id`;
    await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${et.id}, true)`;
    expect(await withUser(user.id, (tx) => tx`select * from app.event_type_sf_settings`)).toHaveLength(0);
    await expect(
      withUser(user.id, (tx) => tx`insert into app.event_type_sf_settings (event_type_id) values (${et.id})`),
    ).rejects.toThrow();
    expect(await withUser(admin.id, (tx) => tx`select * from app.event_type_sf_settings`)).toHaveLength(1);
  });

  it("prevents non-admins from promoting themselves", async () => {
    const u = await makeUser(sql);
    await expect(withUser(u.id, (tx) => tx`update app.users set role = 'admin' where id = ${u.id}`)).rejects.toThrow(
      /only admins/,
    );
    await withUser(u.id, (tx) => tx`update app.users set name = 'New Name' where id = ${u.id}`);
    const [row] = await sql`select name, role from app.users where id = ${u.id}`;
    expect(row).toMatchObject({ name: "New Name", role: "user" });
  });

  it("lets team admins manage their team but not Slack or queue config", async () => {
    const ta = await makeUser(sql);
    const outsider = await makeUser(sql);
    const [team] = await sql`insert into app.teams (name, slug) values ('Sales', 'sales') returning id`;
    await sql`insert into app.team_admins (team_id, user_id) values (${team.id}, ${ta.id})`;
    await withUser(ta.id, (tx) => tx`insert into app.team_members (team_id, email) values (${team.id}, 'rep@bigthinkcapital.com')`);
    await expect(
      withUser(ta.id, (tx) => tx`insert into app.team_slack_channels (team_id, channel_id) values (${team.id}, 'C0123456')`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withUser(ta.id, (tx) => tx`insert into app.team_sf_queues (team_id, queue_id) values (${team.id}, '00GHp000006YkOgMAK')`),
    ).rejects.toThrow(/row-level security/);
    expect(await withUser(outsider.id, (tx) => tx`select id from app.team_members`)).toHaveLength(0);
  });

  it("keeps the audit log append-only", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    await withUser(admin.id, (tx) => tx`insert into app.audit_log (actor_user_id, action, entity_type) values (${admin.id}, 'x', 'y')`);
    await expect(withUser(admin.id, (tx) => tx`delete from app.audit_log`)).rejects.toThrow(/permission denied/);
    await expect(withUser(admin.id, (tx) => tx`update app.audit_log set action = 'z'`)).rejects.toThrow(/permission denied/);
  });

  it("blocks double booking a host at the database level", async () => {
    const host = await makeUser(sql);
    const [et] = await sql`insert into app.event_types (owner_user_id, slug, name) values (${host.id}, 'intro', 'Intro') returning id`;
    const mk = async (tok: string) => {
      const [b] = await sql`
        insert into app.bookings (event_type_id, start_at, end_at, invitee_name, invitee_email, invitee_timezone,
                                  location_type, manage_token_hash)
        values (${et.id}, '2026-11-02T15:00:00Z', '2026-11-02T15:30:00Z', 'A', 'a@example.com', 'UTC', 'teams', ${tok})
        returning id`;
      return b.id as string;
    };
    const b1 = await mk("t1");
    const b2 = await mk("t2");
    await sql`insert into app.booking_hosts (booking_id, user_id, blocked_range) values (${b1}, ${host.id}, '[2026-11-02T15:00:00Z,2026-11-02T15:30:00Z)')`;
    await expect(
      sql`insert into app.booking_hosts (booking_id, user_id, blocked_range) values (${b2}, ${host.id}, '[2026-11-02T15:15:00Z,2026-11-02T15:45:00Z)')`,
    ).rejects.toThrow(/booking_hosts_no_overlap/);
    // Adjacent slots are fine (half-open ranges).
    await sql`insert into app.booking_hosts (booking_id, user_id, blocked_range) values (${b2}, ${host.id}, '[2026-11-02T15:30:00Z,2026-11-02T16:00:00Z)')`;
  });
});

describe("RLS with INSERT ... RETURNING", () => {
  let s: Sql;
  beforeAll(() => {
    s = connectTestDb();
  });
  afterAll(async () => {
    await s.end();
  });

  it("returns the new row for event types and schedules created by their owner", async () => {
    const u = await makeUser(s);
    const [et] = await withUser(u.id, (tx) => tx`insert into app.event_types (owner_user_id, slug, name) values (${u.id}, 'ret', 'Ret') returning id`);
    expect(et.id).toBeTruthy();
    const [sc] = await withUser(u.id, (tx) => tx`insert into app.availability_schedules (owner_user_id, name) values (${u.id}, 'x') returning id`);
    expect(sc.id).toBeTruthy();
  });
});
