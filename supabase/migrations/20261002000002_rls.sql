-- Row Level Security for every table in the app schema.
--
-- Policies apply to the app_user role, which user-scoped requests assume with
-- SET LOCAL ROLE app_user. Tables with no app_user policy (sessions, oauth_states,
-- rate_limits, webhook_nonces) are reachable only by the service module.

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies do not recurse into RLS)
-- ---------------------------------------------------------------------------
create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.users u
    where u.id = app.current_user_id() and u.role = 'admin' and u.is_active
  )
$$;

create or replace function app.is_team_admin(p_team_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.is_admin() or exists (
    select 1 from app.team_admins ta
    where ta.team_id = p_team_id and ta.user_id = app.current_user_id()
  )
$$;

create or replace function app.is_team_member(p_team_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.team_members tm
    where tm.team_id = p_team_id and tm.user_id = app.current_user_id()
  )
$$;

-- Read access to an event type: owner, admins, team admins, and team members.
create or replace function app.can_read_event_type(p_event_type_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.event_types et
    where et.id = p_event_type_id
      and (
        et.owner_user_id = app.current_user_id()
        or app.is_admin()
        or (et.team_id is not null and (app.is_team_admin(et.team_id) or app.is_team_member(et.team_id)))
      )
  )
$$;

-- Write access to an event type: owner, admins, team admins.
create or replace function app.can_write_event_type(p_event_type_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.event_types et
    where et.id = p_event_type_id
      and (
        et.owner_user_id = app.current_user_id()
        or app.is_admin()
        or (et.team_id is not null and app.is_team_admin(et.team_id))
      )
  )
$$;

create or replace function app.can_read_booking(p_booking_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.booking_hosts bh
    where bh.booking_id = p_booking_id and bh.user_id = app.current_user_id()
  ) or exists (
    select 1 from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    where b.id = p_booking_id
      and (
        et.owner_user_id = app.current_user_id()
        or app.is_admin()
        or (et.team_id is not null and app.is_team_admin(et.team_id))
      )
  )
$$;

create or replace function app.can_access_schedule(p_schedule_id uuid, p_write boolean) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.availability_schedules s
    where s.id = p_schedule_id
      and (
        s.owner_user_id = app.current_user_id()
        or app.is_admin()
        or (s.owner_team_id is not null and app.is_team_admin(s.owner_team_id))
        or (not p_write and s.owner_team_id is not null and app.is_team_member(s.owner_team_id))
      )
  )
$$;

revoke all on function app.is_admin() from public;
revoke all on function app.is_team_admin(uuid) from public;
revoke all on function app.is_team_member(uuid) from public;
revoke all on function app.can_read_event_type(uuid) from public;
revoke all on function app.can_write_event_type(uuid) from public;
revoke all on function app.can_read_booking(uuid) from public;
revoke all on function app.can_access_schedule(uuid, boolean) from public;
grant execute on function app.current_user_id() to app_user;
grant execute on function app.is_admin() to app_user;
grant execute on function app.is_team_admin(uuid) to app_user;
grant execute on function app.is_team_member(uuid) to app_user;
grant execute on function app.can_read_event_type(uuid) to app_user;
grant execute on function app.can_write_event_type(uuid) to app_user;
grant execute on function app.can_read_booking(uuid) to app_user;
grant execute on function app.can_access_schedule(uuid, boolean) to app_user;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
grant select on app.users to app_user;
grant update (name, timezone, slug, languages, photo_url, role, is_active) on app.users to app_user;

create policy users_select on app.users for select to app_user using (true);
create policy users_update_self on app.users for update to app_user
  using (id = app.current_user_id() or app.is_admin())
  with check (id = app.current_user_id() or app.is_admin());

-- Only admins may change role or is_active, even on their own row.
-- SECURITY INVOKER on purpose: current_user must be the caller's role (app_user).
create or replace function app.guard_user_privileged_columns() returns trigger
language plpgsql security invoker set search_path = app, pg_temp as $$
begin
  if current_user = 'app_user'
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active)
     and not app.is_admin() then
    raise exception 'only admins can change role or is_active' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger users_guard_privileged before update on app.users
  for each row execute function app.guard_user_privileged_columns();

-- admin_seeds
grant select, insert, delete on app.admin_seeds to app_user;
create policy admin_seeds_admin on app.admin_seeds for all to app_user
  using (app.is_admin()) with check (app.is_admin());

-- calendar_connections: token columns are never granted to app_user.
grant select (user_id, status, scopes, token_expires_at, subscription_expires_at, last_synced_at,
              last_error, broken_at, created_at, updated_at)
  on app.calendar_connections to app_user;
create policy calendar_connections_select on app.calendar_connections for select to app_user
  using (user_id = app.current_user_id() or app.is_admin());

-- busy_blocks
grant select on app.busy_blocks to app_user;
create policy busy_blocks_select on app.busy_blocks for select to app_user
  using (user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on app.teams to app_user;
create policy teams_select on app.teams for select to app_user using (true);
create policy teams_insert on app.teams for insert to app_user with check (app.is_admin());
create policy teams_update on app.teams for update to app_user
  using (app.is_team_admin(id)) with check (app.is_team_admin(id));
create policy teams_delete on app.teams for delete to app_user using (app.is_admin());

grant select, insert, update, delete on app.team_members to app_user;
create policy team_members_select on app.team_members for select to app_user
  using (user_id = app.current_user_id() or app.is_team_admin(team_id) or app.is_team_member(team_id));
create policy team_members_write on app.team_members for all to app_user
  using (app.is_team_admin(team_id)) with check (app.is_team_admin(team_id));

grant select, insert, delete on app.team_admins to app_user;
create policy team_admins_select on app.team_admins for select to app_user using (true);
create policy team_admins_write on app.team_admins for all to app_user
  using (app.is_admin()) with check (app.is_admin());

grant select, insert, update, delete on app.team_sf_queues to app_user;
create policy team_sf_queues_select on app.team_sf_queues for select to app_user
  using (app.is_team_admin(team_id));
create policy team_sf_queues_write on app.team_sf_queues for all to app_user
  using (app.is_admin()) with check (app.is_admin());

grant select, insert, update, delete on app.team_slack_channels to app_user;
create policy team_slack_channels_select on app.team_slack_channels for select to app_user
  using (app.is_team_admin(team_id));
create policy team_slack_channels_write on app.team_slack_channels for all to app_user
  using (app.is_admin()) with check (app.is_admin());

grant select on app.slack_identities to app_user;
create policy slack_identities_select on app.slack_identities for select to app_user
  using (user_id = app.current_user_id() or app.is_admin());

grant select, insert on app.membership_events to app_user;
create policy membership_events_select on app.membership_events for select to app_user
  using (app.is_team_admin(team_id));
create policy membership_events_insert on app.membership_events for insert to app_user
  with check (app.is_team_admin(team_id) and actor_user_id = app.current_user_id());

grant select, update on app.sync_alerts to app_user;
create policy sync_alerts_select on app.sync_alerts for select to app_user
  using (app.is_admin() or (team_id is not null and app.is_team_admin(team_id)));
create policy sync_alerts_update on app.sync_alerts for update to app_user
  using (app.is_admin()) with check (app.is_admin());

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on app.availability_schedules to app_user;
create policy schedules_select on app.availability_schedules for select to app_user
  using (app.can_access_schedule(id, false));
create policy schedules_insert on app.availability_schedules for insert to app_user
  with check (
    owner_user_id = app.current_user_id()
    or app.is_admin()
    or (owner_team_id is not null and app.is_team_admin(owner_team_id))
  );
create policy schedules_update on app.availability_schedules for update to app_user
  using (app.can_access_schedule(id, true))
  with check (
    owner_user_id = app.current_user_id()
    or app.is_admin()
    or (owner_team_id is not null and app.is_team_admin(owner_team_id))
  );
create policy schedules_delete on app.availability_schedules for delete to app_user
  using (app.can_access_schedule(id, true));

grant select, insert, update, delete on app.availability_overrides to app_user;
create policy overrides_select on app.availability_overrides for select to app_user
  using (app.can_access_schedule(schedule_id, false));
create policy overrides_write on app.availability_overrides for all to app_user
  using (app.can_access_schedule(schedule_id, true))
  with check (app.can_access_schedule(schedule_id, true));

grant select, insert, update on app.user_settings to app_user;
create policy user_settings_own on app.user_settings for all to app_user
  using (user_id = app.current_user_id() or app.is_admin())
  with check (user_id = app.current_user_id() or app.is_admin());

-- ---------------------------------------------------------------------------
-- Event types
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on app.event_types to app_user;
create policy event_types_select on app.event_types for select to app_user
  using (app.can_read_event_type(id));
create policy event_types_insert on app.event_types for insert to app_user
  with check (
    owner_user_id = app.current_user_id()
    or app.is_admin()
    or (team_id is not null and app.is_team_admin(team_id))
  );
create policy event_types_update on app.event_types for update to app_user
  using (app.can_write_event_type(id))
  with check (
    owner_user_id = app.current_user_id()
    or app.is_admin()
    or (team_id is not null and app.is_team_admin(team_id))
  );
create policy event_types_delete on app.event_types for delete to app_user
  using (app.can_write_event_type(id));

grant select, insert, update, delete on app.event_type_hosts to app_user;
create policy event_type_hosts_select on app.event_type_hosts for select to app_user
  using (app.can_read_event_type(event_type_id));
create policy event_type_hosts_write on app.event_type_hosts for all to app_user
  using (app.can_write_event_type(event_type_id))
  with check (app.can_write_event_type(event_type_id));

grant select, insert, update, delete on app.event_type_questions to app_user;
create policy event_type_questions_select on app.event_type_questions for select to app_user
  using (app.can_read_event_type(event_type_id));
create policy event_type_questions_write on app.event_type_questions for all to app_user
  using (app.can_write_event_type(event_type_id))
  with check (app.can_write_event_type(event_type_id));

-- Salesforce settings are admin-only for both read and write.
grant select, insert, update, delete on app.event_type_sf_settings to app_user;
create policy event_type_sf_settings_admin on app.event_type_sf_settings for all to app_user
  using (app.is_admin()) with check (app.is_admin());

-- ---------------------------------------------------------------------------
-- Bookings (inserts happen only in the service module's booking transaction)
-- ---------------------------------------------------------------------------
grant select on app.bookings to app_user;
grant update (status, cancel_reason, cancelled_by, cancelled_at, flagged_reason) on app.bookings to app_user;
create policy bookings_select on app.bookings for select to app_user
  using (app.can_read_booking(id));
create policy bookings_update on app.bookings for update to app_user
  using (app.can_read_booking(id)) with check (app.can_read_booking(id));

grant select on app.booking_hosts to app_user;
create policy booking_hosts_select on app.booking_hosts for select to app_user
  using (app.can_read_booking(booking_id));

grant select on app.booking_answers to app_user;
create policy booking_answers_select on app.booking_answers for select to app_user
  using (app.can_read_booking(booking_id));

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
grant select on app.jobs to app_user;
grant update (status, run_at, attempts) on app.jobs to app_user;
create policy jobs_admin_select on app.jobs for select to app_user using (app.is_admin());
create policy jobs_admin_update on app.jobs for update to app_user
  using (app.is_admin()) with check (app.is_admin());

grant select on app.job_attempts to app_user;
create policy job_attempts_admin on app.job_attempts for select to app_user using (app.is_admin());

grant select on app.sf_lead_jobs to app_user;

grant select, insert on app.audit_log to app_user;
create policy audit_log_select on app.audit_log for select to app_user using (app.is_admin());
create policy audit_log_insert on app.audit_log for insert to app_user
  with check (actor_user_id = app.current_user_id());

-- The view runs with the invoker's rights so jobs RLS applies.
alter view app.sf_lead_jobs set (security_invoker = true);

-- Seed global admins.
insert into app.admin_seeds (email, note) values
  ('mike.perticone@bigthinkcapital.com', 'Global admin (initial seed)'),
  ('brian.weiss@bigthinkcapital.com', 'Global admin (initial seed)')
on conflict do nothing;
