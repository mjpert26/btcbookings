-- Integration of the internal UI with the queue sync module.
--
-- 1. app.enqueue_membership_slack_sync() now accepts team admins of the event's team, not
--    only global admins. Team admins manage their roster (add, pause, unpause, remove manual
--    members) and those changes must reach Slack the same way admin overrides do. The
--    function still requires that the caller wrote the membership event.
-- 2. app.enqueue_member_reassignments() enqueues booking_reassign jobs for the future
--    confirmed bookings (member as active primary host) of a member who was just paused by
--    hand, when the team's removal_policy is 'reassign'. It mirrors what queue sync does for
--    members removed from a queue. app_user has no insert grant on app.jobs, so this runs as
--    the table owner and checks the caller itself.
--
-- No new tables; RLS is unchanged.

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
      and bh.user_id = member_user and bh.role = 'primary' and bh.active
      and bk.status = 'confirmed' and bk.start_at > now()
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
