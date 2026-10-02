import "server-only";
import type { Tx } from "@/server/db/client";
import type { EventTypeBundle, EventTypeQuestionRow, EventTypeRow, EventTypeSfSettingsRow } from "@/server/scheduling/resolve";

export type HostRow = {
  team_member_id: string;
  is_required: boolean;
  weight_override: number | null;
  priority_tier_override: number | null;
};

export type TeamMemberOption = {
  id: string;
  name: string;
  email: string;
  status: string;
  weight: number;
  priority_tier: number;
};

const ET_COLUMNS = [
  "id", "owner_user_id", "team_id", "slug", "language", "parent_event_type_id", "overrides", "name", "description",
  "durations", "default_duration", "location_type", "location_detail", "schedule_id", "buffer_before_min",
  "buffer_after_min", "min_notice_min", "max_per_day", "booking_window_days", "slot_interval_min", "scheduling_mode",
  "rr_strategy", "rr_sticky_returning_invitee", "reminder_offsets_min", "is_active", "is_listed", "brand_accent",
] as const;

export async function loadBundle(tx: Tx, id: string): Promise<EventTypeBundle<HostRow> | null> {
  const [eventType] = await tx<EventTypeRow[]>`select ${tx(ET_COLUMNS as unknown as string[])} from app.event_types where id = ${id}`;
  if (!eventType) return null;
  const questions = await tx<EventTypeQuestionRow[]>`
    select id, event_type_id, key, type, label, options, required, position
    from app.event_type_questions where event_type_id = ${id} order by position, key
  `;
  // RLS returns no row for non-admins, so sfSettings is null for them.
  const [sfSettings] = await tx<EventTypeSfSettingsRow[]>`
    select event_type_id, create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id
    from app.event_type_sf_settings where event_type_id = ${id}
  `;
  const hosts = await tx<HostRow[]>`
    select team_member_id, is_required, weight_override, priority_tier_override
    from app.event_type_hosts where event_type_id = ${id}
  `;
  return { eventType, questions, sfSettings: sfSettings ?? null, hosts };
}

export async function canWrite(tx: Tx, id: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`select app.can_write_event_type(${id}) as ok`;
  return Boolean(r?.ok);
}

export async function teamMembers(tx: Tx, teamId: string): Promise<TeamMemberOption[]> {
  return tx<TeamMemberOption[]>`
    select tm.id, coalesce(u.name, tm.email) as name, tm.email, tm.status, tm.weight, tm.priority_tier
    from app.team_members tm left join app.users u on u.id = tm.user_id
    where tm.team_id = ${teamId}
    order by coalesce(u.name, tm.email)
  `;
}

export async function scheduleOptions(tx: Tx, teamId: string | null): Promise<{ id: string; name: string; owner: string }[]> {
  return tx<{ id: string; name: string; owner: string }[]>`
    select s.id, s.name, coalesce(t.name, u.name, '') as owner
    from app.availability_schedules s
    left join app.teams t on t.id = s.owner_team_id
    left join app.users u on u.id = s.owner_user_id
    where s.owner_user_id = app.current_user_id() ${teamId ? tx`or s.owner_team_id = ${teamId}` : tx``}
    order by s.is_default desc, s.name
  `;
}

/** Teams the current user may create team event types for. */
export async function manageableTeams(tx: Tx): Promise<{ id: string; name: string; slug: string }[]> {
  return tx<{ id: string; name: string; slug: string }[]>`
    select id, name, slug from app.teams where app.is_team_admin(id) order by name
  `;
}
