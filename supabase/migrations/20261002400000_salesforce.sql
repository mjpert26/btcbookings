-- Salesforce lead creation (Phase 7).
--
-- 1. Optional follow-up steps the n8n lead workflow performs after the Lead insert.
--    They mirror the "Calendly - SF Meeting Booked (shared)" writer and default to off.
-- 2. app.retry_sf_lead_job(): the only way the admin UI re-queues a lead job. It runs as
--    the table owner so app_user needs no extra column grants on jobs or bookings, and it
--    enforces app.is_admin() itself.

alter table app.event_type_sf_settings
  add column create_task boolean not null default false,
  add column create_note boolean not null default false,
  add column set_meeting_booked_fields boolean not null default false;

comment on column app.bookings.sf_lead_status is
  'null | pending | created | duplicate | failed | skipped';

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

  -- Attempt history stays in app.job_attempts; the counter is kept and the ceiling raised.
  update app.jobs set
    status = 'pending',
    run_at = now(),
    locked_until = null,
    max_attempts = j.attempts + p_extra_attempts
  where app.jobs.id = p_job_id;

  if j.booking_id is not null then
    update app.bookings set sf_lead_status = 'pending'
    where app.bookings.id = j.booking_id and sf_lead_id is null;
  end if;

  return query
    select x.id, x.booking_id, x.status, x.attempts, x.max_attempts, x.run_at,
           j.status, j.max_attempts, j.last_error
    from app.jobs x where x.id = p_job_id;
end
$$;

revoke all on function app.retry_sf_lead_job(uuid, int) from public;
grant execute on function app.retry_sf_lead_job(uuid, int) to app_user;
