-- Calendly import support.
--
-- Imported rows carry (import_source, import_ref) so the import is idempotent and can be
-- re-run to pick up changes. Imported bookings are records only: Calendly still owns the
-- invitee communication for them, so they must never produce outbound side effects
-- (Outlook writes, emails, Salesforce leads, reassignment). A trigger on app.jobs enforces
-- that for every code path.

alter table app.teams add column if not exists import_source text;
alter table app.teams add column if not exists import_ref text;
create unique index if not exists teams_import_ref_idx
  on app.teams (import_source, import_ref) where import_ref is not null;

alter table app.event_types add column if not exists import_source text;
alter table app.event_types add column if not exists import_ref text;
create unique index if not exists event_types_import_ref_idx
  on app.event_types (import_source, import_ref) where import_ref is not null;

alter table app.bookings add column if not exists import_source text;
alter table app.bookings add column if not exists import_ref text;
create unique index if not exists bookings_import_ref_idx
  on app.bookings (import_source, import_ref) where import_ref is not null;

-- app_user reads bookings through a column-level grant; expose the new columns.
grant select (import_source, import_ref) on app.bookings to app_user;

create or replace function app.skip_jobs_for_imported_bookings()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
declare
  target uuid := new.booking_id;
  raw text := new.payload ->> 'bookingId';
begin
  if target is null and raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    target := raw::uuid;
  end if;
  if target is not null and exists (
    select 1 from app.bookings b where b.id = target and b.import_source is not null
  ) then
    return null;  -- silently drop: imported bookings never trigger outbound work
  end if;
  return new;
end;
$$;

create trigger jobs_skip_imported_bookings
  before insert on app.jobs
  for each row execute function app.skip_jobs_for_imported_bookings();
