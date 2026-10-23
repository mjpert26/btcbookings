-- Account link requests.
--
-- Imported Calendly accounts carry an email derived from the Calendly booking link. When a
-- Microsoft sign-in matches no account by object id, email or user principal name, but its
-- display name matches exactly one dormant imported account, the sign-in is held and a
-- request is recorded here. An admin confirms or rejects it on Admin > Users. A display name
-- alone never links an account, because two employees can share a name.
--
-- Rows are written by the sign-in flow on the service connection. Admins read and decide
-- requests through app_user with RLS. Linking itself runs through
-- app.link_imported_account(), because app_user has no grant on users.entra_oid or email.

create table app.account_link_requests (
  id uuid primary key default gen_random_uuid(),
  -- The imported account the sign-in would link to.
  user_id uuid not null references app.users (id) on delete cascade,
  -- The Microsoft account that signed in.
  entra_oid text not null check (char_length(entra_oid) between 1 and 200),
  email citext not null check (char_length(email) <= 320),
  name text not null check (char_length(name) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  attempts integer not null default 1 check (attempts > 0),
  requested_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references app.users (id) on delete set null,
  check ((status = 'pending') = (decided_at is null)),
  unique (user_id, entra_oid)
);

create index account_link_requests_pending_idx on app.account_link_requests (last_requested_at desc) where status = 'pending';
create index account_link_requests_oid_idx on app.account_link_requests (entra_oid);

alter table app.account_link_requests enable row level security;

grant select on app.account_link_requests to app_user;
grant update (status, decided_at, decided_by) on app.account_link_requests to app_user;

create policy account_link_requests_select on app.account_link_requests for select to app_user using (app.is_admin());
create policy account_link_requests_update on app.account_link_requests for update to app_user
  using (app.is_admin()) with check (app.is_admin());

-- Links a dormant imported account to a Microsoft account after an admin has confirmed the
-- request. Refuses unless the caller is an admin, the account has never signed in and is not
-- linked, and no other account holds the object id or the email. Returns whether it linked.
create or replace function app.link_imported_account(p_user_id uuid, p_entra_oid text, p_email citext) returns boolean
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if exists (select 1 from app.users where id <> p_user_id and (entra_oid = p_entra_oid or email = p_email)) then
    return false;
  end if;
  update app.users
  set entra_oid = p_entra_oid, email = p_email
  where id = p_user_id and entra_oid is null and last_login_at is null and import_source = 'calendly' and is_active;
  return found;
end;
$$;

revoke all on function app.link_imported_account(uuid, text, citext) from public;
grant execute on function app.link_imported_account(uuid, text, citext) to app_user;
