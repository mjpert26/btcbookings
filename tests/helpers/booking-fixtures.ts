import { randomBytes } from "node:crypto";
import type { Sql } from "@/server/db/client";

/** Minimal event types and bookings for integration tests outside the booking module. */
let n = 0;
const slug = (p: string) => `${p}-${++n}-${randomBytes(3).toString("hex")}`;

export async function makeIndividualEventType(
  sql: Sql,
  ownerId: string,
  over: { name?: string; locationType?: "teams" | "phone" | "in_person" | "custom"; policy?: "auto_cancel" | "flag" } = {},
): Promise<string> {
  const [et] = await sql<{ id: string }[]>`
    insert into app.event_types (owner_user_id, slug, name, location_type, scheduling_mode)
    values (${ownerId}, ${slug("et")}, ${over.name ?? "Intro Call"}, ${over.locationType ?? "teams"}, 'individual')
    returning id
  `;
  await sql`
    insert into app.user_settings (user_id, outlook_conflict_policy) values (${ownerId}, ${over.policy ?? "flag"})
    on conflict (user_id) do update set outlook_conflict_policy = excluded.outlook_conflict_policy
  `;
  return et.id;
}

export async function makeTeamEventType(
  sql: Sql,
  over: { name?: string; mode?: "round_robin" | "collective"; policy?: "auto_cancel" | "flag"; locationType?: "teams" | "phone" } = {},
): Promise<{ eventTypeId: string; teamId: string }> {
  const [team] = await sql<{ id: string }[]>`
    insert into app.teams (name, slug, outlook_conflict_policy) values ('Sales', ${slug("team")}, ${over.policy ?? "flag"})
    returning id
  `;
  const [et] = await sql<{ id: string }[]>`
    insert into app.event_types (team_id, slug, name, location_type, scheduling_mode)
    values (${team.id}, ${slug("tet")}, ${over.name ?? "Team Call"}, ${over.locationType ?? "teams"}, ${over.mode ?? "collective"})
    returning id
  `;
  return { eventTypeId: et.id, teamId: team.id };
}

export async function makeBooking(
  sql: Sql,
  p: {
    eventTypeId: string;
    hosts: { userId: string; role?: "primary" | "collective"; graphEventId?: string | null }[];
    start: Date;
    end: Date;
    status?: "confirmed" | "cancelled" | "flagged";
    locationType?: "teams" | "phone" | "in_person" | "custom";
    inviteeName?: string;
    inviteeEmail?: string;
    inviteePhone?: string | null;
  },
): Promise<string> {
  const [b] = await sql<{ id: string }[]>`
    insert into app.bookings (event_type_id, status, start_at, end_at, invitee_name, invitee_email, invitee_phone,
                              invitee_timezone, location_type, manage_token_hash)
    values (${p.eventTypeId}, ${p.status ?? "confirmed"}, ${p.start}, ${p.end}, ${p.inviteeName ?? "Jane Invitee"},
            ${p.inviteeEmail ?? "jane@example.com"}, ${p.inviteePhone ?? null}, 'America/Chicago',
            ${p.locationType ?? "teams"}, ${randomBytes(32).toString("hex")})
    returning id
  `;
  for (const h of p.hosts) {
    await sql`
      insert into app.booking_hosts (booking_id, user_id, role, blocked_range, graph_event_id, active)
      values (${b.id}, ${h.userId}, ${h.role ?? "primary"}, tstzrange(${p.start}, ${p.end}), ${h.graphEventId ?? null},
              ${p.status !== "cancelled"})
    `;
  }
  return b.id;
}
