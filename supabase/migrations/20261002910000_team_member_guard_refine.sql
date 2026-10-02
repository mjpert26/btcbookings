-- Refines app.guard_team_member_changes: on queue_plus_manual teams, team admins may add,
-- remove and pause MANUAL members. Queue-sourced members (and every member of a
-- salesforce_queue team) stay managed by sync and global admins.
create or replace function app.guard_team_member_changes() returns trigger
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_source app.membership_source;
  v_team uuid := coalesce(new.team_id, old.team_id);
  v_row_source app.member_origin := coalesce(old.source, new.source);
  v_touches_membership boolean;
begin
  if current_user <> 'app_user' or app.is_admin() then
    return coalesce(new, old);
  end if;
  select membership_source into v_source from app.teams where id = v_team;
  v_touches_membership := tg_op in ('INSERT', 'DELETE')
    or new.status is distinct from old.status
    or new.source is distinct from old.source
    or new.email is distinct from old.email
    or new.user_id is distinct from old.user_id;
  if v_touches_membership and (
       v_source = 'salesforce_queue'
    or (v_source = 'queue_plus_manual' and (v_row_source = 'queue' or new.source = 'queue'))
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
