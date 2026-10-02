-- Salesforce Queue sync (PLAN 4.5).
--
-- team_sf_queues.last_member_count   active members in the last applied snapshot; drives the
--                                    empty-snapshot guard of the safety rail.
-- team_sf_queues.last_member_emails  active member emails of the last applied snapshot, so a
--                                    single push removal can tell whether the person is still in
--                                    another queue linked to the same team.
-- teams.mass_removal_approved_until  set when an admin resolves a mass_removal_blocked alert and
--                                    approves the change; the next snapshot before this time
--                                    bypasses the safety rail once.
--
-- teams.sync_health values written by sync: 'unknown', 'ok', 'error', 'blocked', 'stale'.

alter table app.team_sf_queues
  add column last_member_count int,
  add column last_member_emails citext[] not null default '{}';

create index team_sf_queues_queue_idx on app.team_sf_queues (queue_id);

alter table app.teams
  add column mass_removal_approved_until timestamptz;

create index sync_alerts_open_idx on app.sync_alerts (team_id, kind) where resolved_at is null;

-- Admin membership overrides run as app_user, which has no insert grant on app.jobs. This
-- function enqueues the Slack sync job for a membership event the caller just wrote, after
-- checking that the caller is a global admin and the author of that event.
create or replace function app.enqueue_membership_slack_sync(p_event_id uuid) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  ev record;
  job_id uuid;
begin
  if not app.is_admin() then
    raise exception 'only admins can enqueue membership sync' using errcode = '42501';
  end if;
  select id, team_id, team_member_id, actor_user_id into ev
  from app.membership_events where id = p_event_id;
  if not found or ev.actor_user_id is distinct from app.current_user_id() or ev.team_member_id is null then
    raise exception 'membership event not found' using errcode = '42501';
  end if;
  insert into app.jobs (kind, payload, team_id, idempotency_key)
  values ('slack_membership_sync',
          jsonb_build_object('teamId', ev.team_id, 'teamMemberId', ev.team_member_id),
          ev.team_id, 'membership_event:' || ev.id)
  on conflict (kind, idempotency_key) do nothing
  returning id into job_id;
  return job_id;
end
$$;

revoke all on function app.enqueue_membership_slack_sync(uuid) from public;
grant execute on function app.enqueue_membership_slack_sync(uuid) to app_user;
