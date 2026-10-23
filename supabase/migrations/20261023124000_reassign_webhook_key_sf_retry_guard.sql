-- Review fixes for booking.reassigned webhooks and Salesforce lead job retries.
--
-- 1. app.booking_hosts_webhook_events(): the idempotency key of a booking.reassigned
--    dispatch now includes the reassignment time. A host who is reassigned away from the
--    same booking a second time (after being assigned to it again) produces a new event
--    instead of reusing the first key, which "on conflict do nothing" silently dropped.
--
-- 2. app.retry_sf_lead_job(): refuses the job of a booking that was rescheduled when a
--    later booking in its reschedule chain has its own sf_lead_create job. That later job
--    owns the Salesforce work for the invitee; retrying the original job would only end as
--    superseded. In 'create' mode the new booking has no job of its own, so the original
--    job can still be retried. Refusals use SQLSTATE BTC01.

create or replace function app.booking_hosts_webhook_events() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  if old.reassigned_at is null and new.reassigned_at is not null and not exists (
    select 1 from app.bookings b where b.id = new.booking_id and b.import_source is not null
  ) then
    perform app.enqueue_booking_webhook(
      new.booking_id,
      'booking.reassigned',
      new.booking_id::text || ':webhook:reassigned:' || new.user_id::text || ':'
        || ((extract(epoch from new.reassigned_at) * 1000000)::bigint)::text
    );
  end if;
  return null;
end;
$$;
revoke all on function app.booking_hosts_webhook_events() from public;

create or replace function app.retry_sf_lead_job(p_job_id uuid, p_extra_attempts int)
returns table (
  id uuid,
  booking_id uuid,
  status app.job_status,
  attempts int,
  max_attempts int,
  run_at timestamptz,
  prev_status app.job_status,
  prev_max_attempts int,
  prev_last_error text
)
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  j app.jobs%rowtype;
begin
  if not app.is_admin() then
    raise exception 'only admins can retry Salesforce lead jobs' using errcode = '42501';
  end if;
  if p_extra_attempts is null or p_extra_attempts < 1 then
    raise exception 'p_extra_attempts must be positive' using errcode = '22023';
  end if;

  select * into j from app.jobs where app.jobs.id = p_job_id and kind = 'sf_lead_create' for update;
  if not found then
    raise exception 'job not found' using errcode = 'P0002';
  end if;
  if j.status not in ('dead', 'failed') then
    raise exception 'job is %, only dead or failed jobs can be retried', j.status using errcode = '55000';
  end if;

  if j.booking_id is not null and exists (
    with recursive later(id, depth) as (
      select b.id, 1 from app.bookings b where b.rescheduled_from_id = j.booking_id
      union all
      select b.id, l.depth + 1 from app.bookings b join later l on b.rescheduled_from_id = l.id
      where l.depth < 100
    )
    select 1
    from app.bookings ob
    where ob.id = j.booking_id and ob.status = 'rescheduled'
      and exists (
        select 1 from app.jobs lj
        where lj.kind = 'sf_lead_create' and lj.booking_id in (select later.id from later)
      )
  ) then
    raise exception 'the booking was rescheduled; retry the Salesforce job of the new booking'
      using errcode = 'BTC01';
  end if;

  -- Attempt history stays in app.job_attempts; the counter is kept and the ceiling raised.
  update app.jobs set
    status = 'pending',
    run_at = now(),
    locked_until = null,
    max_attempts = j.attempts + p_extra_attempts
  where app.jobs.id = p_job_id;

  if j.booking_id is not null then
    update app.bookings set sf_lead_status = 'pending'
    where app.bookings.id = j.booking_id
      and (sf_lead_id is null or coalesce(j.payload ->> 'isReschedule', 'false') = 'true');
  end if;

  return query
    select x.id, x.booking_id, x.status, x.attempts, x.max_attempts, x.run_at,
           j.status, j.max_attempts, j.last_error
    from app.jobs x where x.id = p_job_id;
end
$$;

revoke all on function app.retry_sf_lead_job(uuid, int) from public;
grant execute on function app.retry_sf_lead_job(uuid, int) to app_user;
