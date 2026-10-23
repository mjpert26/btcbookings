-- Salesforce lead handling modes (BTCSCHED-71).
--
-- lead_mode decides what the n8n lead workflow does with a booking:
--   match_or_create  Update the open Lead with the invitee's email; skip when the only match
--                    is a converted Lead; otherwise create a Lead. Same as the Calendly
--                    "create" mapping.
--   update_only      Update the open Lead with the invitee's email; never create one. Same as
--                    the Calendly "update" mapping.
--   create           Always insert a new Lead (the original behavior). Reschedules do not
--                    call Salesforce.
-- Rows that exist before this migration keep 'create' so their behavior does not change.
-- Rows created afterwards default to 'match_or_create'.
--
-- New booking lead outcome: 'updated' (an existing Lead was matched and updated).
-- app.retry_sf_lead_job() also resets the status of reschedule jobs, whose booking already
-- carries the Lead Id of the original booking.

create type app.sf_lead_mode as enum ('match_or_create', 'update_only', 'create');

alter table app.event_type_sf_settings add column lead_mode app.sf_lead_mode not null default 'create';
alter table app.event_type_sf_settings alter column lead_mode set default 'match_or_create';

comment on column app.event_type_sf_settings.lead_mode is
  'match_or_create | update_only | create. See docs/n8n-workflows.md.';

comment on column app.bookings.sf_lead_status is
  'null | pending | created | updated | duplicate | failed | skipped';

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
