-- Security hardening from the pre-launch review.

-- 1. Hosts removed from a booking by reassignment lose access to it.
alter table app.booking_hosts add column if not exists reassigned_at timestamptz;

create or replace function app.can_read_booking(p_booking_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.booking_hosts bh
    where bh.booking_id = p_booking_id and bh.user_id = app.current_user_id() and bh.reassigned_at is null
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

-- Writes (host cancel) require a current, active host row, or owner / admin / team admin.
create or replace function app.can_write_booking(p_booking_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.booking_hosts bh
    where bh.booking_id = p_booking_id and bh.user_id = app.current_user_id() and bh.active
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
revoke all on function app.can_write_booking(uuid) from public;
grant execute on function app.can_write_booking(uuid) to app_user;

drop policy if exists bookings_update on app.bookings;
create policy bookings_update on app.bookings for update to app_user
  using (app.can_write_booking(id))
  with check (app.can_write_booking(id) and status in ('confirmed', 'cancelled', 'flagged'));

-- 2. Team admins may edit a team's display and conflict settings, but not its sync and
--    safety-rail settings, and may only change membership on manual teams.
create or replace function app.guard_team_admin_columns() returns trigger
language plpgsql security invoker set search_path = app, pg_temp as $$
begin
  if current_user = 'app_user' and not app.is_admin() and (
       new.membership_source is distinct from old.membership_source
    or new.removal_policy is distinct from old.removal_policy
    or new.mass_removal_threshold_pct is distinct from old.mass_removal_threshold_pct
    or new.mass_removal_approved_until is distinct from old.mass_removal_approved_until
    or new.last_synced_at is distinct from old.last_synced_at
    or new.sync_health is distinct from old.sync_health
    or new.slug is distinct from old.slug
  ) then
    raise exception 'only admins can change sync, safety-rail or slug settings' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists teams_guard_admin_columns on app.teams;
create trigger teams_guard_admin_columns before update on app.teams
  for each row execute function app.guard_team_admin_columns();

create or replace function app.guard_team_member_changes() returns trigger
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_source app.membership_source;
  v_team uuid := coalesce(new.team_id, old.team_id);
begin
  if current_user <> 'app_user' or app.is_admin() then
    return coalesce(new, old);
  end if;
  select membership_source into v_source from app.teams where id = v_team;
  if v_source <> 'manual' and (
       tg_op in ('INSERT', 'DELETE')
    or new.status is distinct from old.status
    or new.source is distinct from old.source
    or new.email is distinct from old.email
    or new.user_id is distinct from old.user_id
  ) then
    raise exception 'membership on Salesforce-linked teams is managed by sync and global admins' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       new.rr_assignment_count is distinct from old.rr_assignment_count
    or new.rr_last_assigned_at is distinct from old.rr_last_assigned_at
    or new.sf_user_id is distinct from old.sf_user_id
  ) then
    raise exception 'round-robin counters and Salesforce ids are system-managed' using errcode = '42501';
  end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists team_members_guard on app.team_members;
create trigger team_members_guard before insert or update or delete on app.team_members
  for each row execute function app.guard_team_member_changes();

-- 3. Event types may only use schedules the writer can access.
create or replace function app.guard_event_type_schedule() returns trigger
language plpgsql security invoker set search_path = app, pg_temp as $$
begin
  if current_user = 'app_user' and new.schedule_id is not null
     and (tg_op = 'INSERT' or new.schedule_id is distinct from old.schedule_id)
     and not app.can_access_schedule(new.schedule_id, false) then
    raise exception 'schedule not accessible' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists event_types_guard_schedule on app.event_types;
create trigger event_types_guard_schedule before insert or update on app.event_types
  for each row execute function app.guard_event_type_schedule();

-- 4. Bind the OIDC state to the browser that started sign-in (login CSRF protection).
alter table app.oauth_states add column if not exists browser_binding text;
