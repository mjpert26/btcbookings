import { DateTime } from "luxon";
import type { Sql } from "@/server/db/client";
import { makeUser } from "./db";

/** Fixtures for booking integration and e2e tests. Hosts are open around the clock by default. */

export const ALWAYS_OPEN_RULES = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "00:00", end: "24:00" }]]),
);

let seq = 0;

export async function makeHost(
  sql: Sql,
  over: {
    name?: string;
    slug?: string;
    calendar?: "healthy" | "broken";
    timezone?: string;
    weekly?: Record<string, { start: string; end: string }[]>;
    notifyByEmail?: boolean;
    dailyCap?: number | null;
    photoUrl?: string | null;
  } = {},
): Promise<{ id: string; email: string; slug: string; scheduleId: string }> {
  seq++;
  const u = await makeUser(sql, { name: over.name ?? `Host ${seq}`, calendar: over.calendar ?? "healthy", timezone: over.timezone });
  const slug = over.slug ?? `host-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await sql`update app.users set slug = ${slug}, photo_url = ${over.photoUrl ?? null} where id = ${u.id}`;
  const [s] = await sql<{ id: string }[]>`
    insert into app.availability_schedules (owner_user_id, name, timezone, weekly_rules, is_default)
    values (${u.id}, 'Working hours', ${over.timezone ?? "America/New_York"},
            ${sql.json((over.weekly ?? ALWAYS_OPEN_RULES) as never)}, true)
    returning id
  `;
  await sql`
    insert into app.user_settings (user_id, notify_host_by_email, daily_booking_cap)
    values (${u.id}, ${over.notifyByEmail ?? false}, ${over.dailyCap ?? null})
  `;
  return { id: u.id, email: u.email, slug, scheduleId: s.id };
}

type EventOver = Partial<{
  slug: string;
  name: string;
  language: string;
  parentId: string | null;
  overrides: string[];
  durations: number[];
  defaultDuration: number;
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  mode: "individual" | "round_robin" | "collective";
  strategy: "fairness" | "weighted" | "priority";
  sticky: boolean;
  reminders: number[];
  isListed: boolean;
  isActive: boolean;
  description: Record<string, string>;
  locationType: "teams" | "phone" | "in_person" | "custom";
  locationDetail: string | null;
  maxPerDay: number | null;
}>;

export async function makeEvent(
  sql: Sql,
  owner: { userId?: string; teamId?: string },
  over: EventOver = {},
): Promise<{ id: string; slug: string }> {
  const slug = over.slug ?? `meet-${++seq}`;
  const durations = over.durations ?? [30];
  const [row] = await sql<{ id: string }[]>`
    insert into app.event_types (
      owner_user_id, team_id, slug, language, parent_event_type_id, overrides, name, description,
      durations, default_duration, location_type, location_detail, buffer_before_min, buffer_after_min,
      min_notice_min, scheduling_mode, rr_strategy, rr_sticky_returning_invitee, reminder_offsets_min,
      is_listed, is_active, max_per_day
    ) values (
      ${owner.userId ?? null}, ${owner.teamId ?? null}, ${slug}, ${over.language ?? "en"}, ${over.parentId ?? null},
      ${over.overrides ?? []}, ${over.name ?? "Intro call"}, ${sql.json((over.description ?? { en: "A short intro call." }) as never)},
      ${durations}, ${over.defaultDuration ?? durations[0]}, ${over.locationType ?? "teams"}, ${over.locationDetail ?? null},
      ${over.bufferBefore ?? 0}, ${over.bufferAfter ?? 0}, ${over.minNotice ?? 0},
      ${over.mode ?? (owner.teamId ? "round_robin" : "individual")}, ${over.strategy ?? "fairness"},
      ${over.sticky ?? false}, ${over.reminders ?? [1440, 60]}, ${over.isListed ?? true}, ${over.isActive ?? true},
      ${over.maxPerDay ?? null}
    ) returning id
  `;
  return { id: row.id, slug };
}

export async function makeTeam(
  sql: Sql,
  memberUserIds: string[],
  over: { slug?: string; name?: string } = {},
): Promise<{ id: string; slug: string; memberIds: Record<string, string> }> {
  const slug = over.slug ?? `team-${++seq}`;
  const [t] = await sql<{ id: string }[]>`insert into app.teams (name, slug) values (${over.name ?? "Sales"}, ${slug}) returning id`;
  const memberIds: Record<string, string> = {};
  for (const userId of memberUserIds) {
    const [u] = await sql<{ email: string }[]>`select email from app.users where id = ${userId}`;
    const [m] = await sql<{ id: string }[]>`
      insert into app.team_members (team_id, user_id, email, status) values (${t.id}, ${userId}, ${u.email}, 'active') returning id
    `;
    memberIds[userId] = m.id;
  }
  return { id: t.id, slug, memberIds };
}

/** A start time on a 30-minute boundary `days` from now at the given UTC hour. */
export function futureSlot(days = 2, hourUtc = 15, minute = 0): string {
  return DateTime.utc().plus({ days }).set({ hour: hourUtc, minute, second: 0, millisecond: 0 }).toISO()!;
}

export function invitee(over: Partial<{ name: string; email: string; timezone: string }> = {}) {
  return {
    name: over.name ?? "Pat Invitee",
    email: over.email ?? `pat.${++seq}@example.com`,
    timezone: over.timezone ?? "America/Chicago",
  };
}
