-- Calendly import guards.
--
-- 1. A stable link between Calendly members and app users. Sign-in can change users.email
--    (for example when a rep is linked by user principal name), so the importer matches
--    members by (import_source, import_ref) before falling back to email.
-- 2. Imported event types go live only through the admin cutover. Until a page is released
--    (import_meta.released_at, set by the cutover), only admins may activate it. Non-admins
--    may never change the import columns.

alter table app.users add column if not exists import_source text;
alter table app.users add column if not exists import_ref text;
create unique index if not exists users_import_ref_idx
  on app.users (import_source, import_ref) where import_ref is not null;

create or replace function app.guard_imported_event_types() returns trigger
language plpgsql security invoker set search_path = app, pg_temp as $$
begin
  if current_user = 'app_user' and not app.is_admin() then
    if new.import_source is distinct from old.import_source
       or new.import_ref is distinct from old.import_ref
       or new.import_meta is distinct from old.import_meta then
      raise exception 'only admins can change import settings' using errcode = '42501';
    end if;
    if new.import_source is not null and new.is_active and not old.is_active
       and (new.import_meta ->> 'released_at') is null then
      raise exception 'imported pages go live through the admin cutover' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

create trigger event_types_guard_imported before update on app.event_types
  for each row execute function app.guard_imported_event_types();
