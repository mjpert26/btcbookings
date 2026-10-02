-- Pins search_path on the two helper functions that did not set it (Supabase linter 0011),
-- and stops anonymous and signed-in Data API callers from executing Supabase's
-- public.rls_auto_enable() helper where a project has it (linter 0028/0029).
alter function app.touch_updated_at() set search_path = app, pg_temp;
alter function app.current_user_id() set search_path = app, pg_temp;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'revoke execute on function public.rls_auto_enable() from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke execute on function public.rls_auto_enable() from authenticated';
    end if;
  end if;
end
$$;
