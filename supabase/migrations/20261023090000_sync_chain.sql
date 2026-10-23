-- Salesforce Queue -> booking pages -> Slack sync chain (BTCSCHED-49, 50, 51).
--
-- 1. app.team_slack_usergroups: an optional Slack user group per team. Its membership
--    follows the team roster the same way linked channels do. New links start in dry-run
--    mode, so linking a group never changes Slack until an admin turns dry run off.
--    Team admins can read the link; only global admins can write it. A user group belongs to
--    one partner team, so usergroup_id is unique: removing a rep from one team's queue can
--    never take them out of a group they still belong to through another team.
-- 2. app.slack_usergroup_actions: per-member log of what the user group sync did (or, in dry
--    run, would have done). Written only by the job worker (service role).
-- 3. app.queue_sync_runs: one row per team per applied, blocked, skipped or failed queue
--    snapshot or push, for the sync status view. Written only by the sync (service role).
--    Repeated no-change runs collapse into one row. Rows not seen for 30 days are purged by
--    the queue sync health cron.
-- 4. app.enqueue_membership_slack_sync() now enqueues Slack work only for teams that have a
--    Slack channel or user group linked, and adds the slack_usergroup_sync job when a user
--    group is linked. Teams without Slack links (for example the teams imported from
--    Calendly) get no Slack jobs at all.
-- 5. app.enqueue_member_reassignments() also covers bookings where the paused member is a
--    collective (non-primary) host, and skips bookings imported from Calendly, which never
--    produce outbound work.

-- ---------------------------------------------------------------------------
-- 1. Slack user group per team
-- ---------------------------------------------------------------------------
create table app.team_slack_usergroups (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null unique references app.teams (id) on delete cascade,
  usergroup_id text not null unique check (usergroup_id ~ '^S[A-Z0-9]{6,}$'),
  usergroup_handle text,
  mode app.slack_mode not null default 'add_only',
  dry_run boolean not null default true,
  protected_slack_user_ids text[] not null default '{}',
  health app.channel_health not null default 'unknown',
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger team_slack_usergroups_touch before update on app.team_slack_usergroups
  for each row execute function app.touch_updated_at();

alter table app.team_slack_usergroups enable row level security;
grant select, insert, update, delete on app.team_slack_usergroups to app_user;
create policy team_slack_usergroups_select on app.team_slack_usergroups for select to app_user
  using (app.is_team_admin(team_id));
create policy team_slack_usergroups_write on app.team_slack_usergroups for all to app_user
  using (app.is_admin()) with check (app.is_admin());

-- ---------------------------------------------------------------------------
-- 2. User group action log
-- ---------------------------------------------------------------------------
create table app.slack_usergroup_actions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  usergroup_config_id uuid references app.team_slack_usergroups (id) on delete set null,
  team_member_id uuid references app.team_members (id) on delete set null,
  usergroup_id text not null,
  slack_user_id text,
  action text not null check (action in ('add', 'remove', 'skip')),
  dry_run boolean not null default false,
  outcome text not null check (outcome in ('done', 'would_do', 'skipped', 'error')),
  error_code text,
  detail text,
  created_at timestamptz not null default now()
);
create index slack_usergroup_actions_team_idx on app.slack_usergroup_actions (team_id, created_at desc);
create index slack_usergroup_actions_member_idx on app.slack_usergroup_actions (team_member_id, created_at desc);

alter table app.slack_usergroup_actions enable row level security;
grant select on app.slack_usergroup_actions to app_user;
create policy slack_usergroup_actions_select on app.slack_usergroup_actions for select to app_user
  using (app.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- 3. Queue sync run history
-- ---------------------------------------------------------------------------
create table app.queue_sync_runs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  source text not null check (source in ('poll', 'push')),
  status text not null check (status in ('applied', 'blocked', 'skipped', 'error')),
  reason text,
  snapshot_id text,
  added int not null default 0,
  removed int not null default 0,
  reinstated int not null default 0,
  promoted int not null default 0,
  events int not null default 0,
  reassign_jobs int not null default 0,
  review_bookings int not null default 0,
  error text,
  -- Consecutive runs with the same outcome and no changes (the normal two-minute poll) are
  -- collapsed into one row: last_seen_at moves forward and repeat_count goes up.
  repeat_count int not null default 1,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index queue_sync_runs_team_idx on app.queue_sync_runs (team_id, last_seen_at desc);

alter table app.queue_sync_runs enable row level security;
grant select on app.queue_sync_runs to app_user;
create policy queue_sync_runs_select on app.queue_sync_runs for select to app_user
  using (app.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- 4. Slack jobs only for teams with Slack links
-- ---------------------------------------------------------------------------
create or replace function app.enqueue_membership_slack_sync(p_event_id uuid) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  ev record;
  job_id uuid;
begin
  select id, team_id, team_member_id, actor_user_id into ev
  from app.membership_events where id = p_event_id;
  if not found or ev.actor_user_id is distinct from app.current_user_id() or ev.team_member_id is null then
    raise exception 'membership event not found' using errcode = '42501';
  end if;
  if not app.is_team_admin(ev.team_id) then
    raise exception 'only team admins can enqueue membership sync' using errcode = '42501';
  end if;
  if exists (select 1 from app.team_slack_channels where team_id = ev.team_id) then
    insert into app.jobs (kind, payload, team_id, idempotency_key)
    values ('slack_membership_sync',
            jsonb_build_object('teamId', ev.team_id, 'teamMemberId', ev.team_member_id),
            ev.team_id, 'membership_event:' || ev.id)
    on conflict (kind, idempotency_key) do nothing
    returning id into job_id;
  end if;
  if exists (select 1 from app.team_slack_usergroups where team_id = ev.team_id) then
    insert into app.jobs (kind, payload, team_id, idempotency_key)
    values ('slack_usergroup_sync',
            jsonb_build_object('teamId', ev.team_id, 'teamMemberId', ev.team_member_id),
            ev.team_id, 'membership_event:' || ev.id)
    on conflict (kind, idempotency_key) do nothing;
  end if;
  return job_id;
end
$$;

revoke all on function app.enqueue_membership_slack_sync(uuid) from public;
grant execute on function app.enqueue_membership_slack_sync(uuid) to app_user;

-- ---------------------------------------------------------------------------
-- 5. Reassignment covers collective hosts and skips imported bookings
-- ---------------------------------------------------------------------------
create or replace function app.enqueue_member_reassignments(p_event_id uuid) returns int
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  ev record;
  member_user uuid;
  policy app.removal_policy;
  n int := 0;
  inserted uuid;
  b record;
begin
  select id, team_id, team_member_id, actor_user_id, new_status into ev
  from app.membership_events where id = p_event_id;
  if not found or ev.actor_user_id is distinct from app.current_user_id() or ev.team_member_id is null then
    raise exception 'membership event not found' using errcode = '42501';
  end if;
  if not app.is_team_admin(ev.team_id) then
    raise exception 'only team admins can enqueue reassignments' using errcode = '42501';
  end if;
  if ev.new_status is distinct from 'paused' then
    return 0;
  end if;
  select removal_policy into policy from app.teams where id = ev.team_id;
  if policy is distinct from 'reassign' then
    return 0;
  end if;
  select user_id into member_user from app.team_members where id = ev.team_member_id;
  if member_user is null then
    return 0;
  end if;

  for b in
    select distinct bk.id, bk.start_at
    from app.bookings bk
    join app.event_types et on et.id = bk.event_type_id
    join app.booking_hosts bh on bh.booking_id = bk.id
    where et.team_id = ev.team_id
      and bh.user_id = member_user and bh.active
      and bk.status = 'confirmed' and bk.start_at > now()
      and bk.import_source is null
    order by bk.start_at
  loop
    inserted := null;
    insert into app.jobs (kind, payload, booking_id, team_id, idempotency_key)
    values ('booking_reassign',
            jsonb_build_object('bookingId', b.id, 'fromUserId', member_user, 'reason', 'paused_by_admin'),
            b.id, ev.team_id, 'reassign:' || b.id || ':' || ev.id)
    on conflict (kind, idempotency_key) do nothing
    returning id into inserted;
    if inserted is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

revoke all on function app.enqueue_member_reassignments(uuid) from public;
grant execute on function app.enqueue_member_reassignments(uuid) to app_user;
