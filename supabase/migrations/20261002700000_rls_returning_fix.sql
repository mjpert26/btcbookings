-- INSERT ... RETURNING under RLS evaluates the SELECT policy against the new row.
-- The original SELECT policies on event_types and availability_schedules called helper
-- functions that look the row up again by id; a STABLE function cannot see a row inserted
-- by the same statement, so RETURNING failed. These policies now test the row's own
-- columns directly. Child tables keep using the helpers (their parent row already exists).

drop policy if exists event_types_select on app.event_types;
create policy event_types_select on app.event_types for select to app_user
  using (
    owner_user_id = app.current_user_id()
    or app.is_admin()
    or (team_id is not null and (app.is_team_admin(team_id) or app.is_team_member(team_id)))
  );

drop policy if exists schedules_select on app.availability_schedules;
create policy schedules_select on app.availability_schedules for select to app_user
  using (
    owner_user_id = app.current_user_id()
    or app.is_admin()
    or (owner_team_id is not null and (app.is_team_admin(owner_team_id) or app.is_team_member(owner_team_id)))
  );
