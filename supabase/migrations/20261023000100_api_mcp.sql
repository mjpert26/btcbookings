-- REST API keys, the OAuth 2.1 authorization server used by MCP clients, and role helpers.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create or replace function app.is_manager() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.users u
    where u.id = app.current_user_id() and u.role in ('admin', 'manager') and u.is_active
  )
$$;
revoke all on function app.is_manager() from public;
grant execute on function app.is_manager() to app_user;

-- Managers read everything admins read; writes still require the existing checks.
create or replace function app.can_read_event_type(p_event_type_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.event_types et
    where et.id = p_event_type_id
      and (
        et.owner_user_id = app.current_user_id()
        or app.is_manager()
        or (et.team_id is not null and (app.is_team_admin(et.team_id) or app.is_team_member(et.team_id)))
      )
  )
$$;

create or replace function app.can_read_booking(p_booking_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.booking_hosts bh
    where bh.booking_id = p_booking_id and bh.user_id = app.current_user_id() and bh.reassigned_at is null
  ) or exists (
    select 1 from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    where b.id = p_booking_id
      and (
        et.owner_user_id = app.current_user_id()
        or app.is_manager()
        or (et.team_id is not null and app.is_team_admin(et.team_id))
      )
  )
$$;

alter policy audit_log_select on app.audit_log using (app.is_manager());

-- The event_types SELECT policy tests the row's columns directly (20261002700000), so it is
-- updated here as well.
alter policy event_types_select on app.event_types using (
  owner_user_id = app.current_user_id()
  or app.is_manager()
  or (team_id is not null and (app.is_team_admin(team_id) or app.is_team_member(team_id)))
);
alter policy team_members_select on app.team_members using (
  user_id = app.current_user_id() or app.is_manager() or app.is_team_admin(team_id) or app.is_team_member(team_id)
);

-- ---------------------------------------------------------------------------
-- How a booking was made
-- ---------------------------------------------------------------------------
alter table app.bookings add column if not exists created_via text not null default 'public'
  check (created_via in ('public', 'api', 'mcp', 'import', 'reschedule'));
grant select (created_via) on app.bookings to app_user;

-- ---------------------------------------------------------------------------
-- OAuth clients and allowed callback URLs
-- ---------------------------------------------------------------------------
create table app.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  name text not null,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  registered_via text not null check (registered_via in ('dynamic', 'admin')),
  created_by uuid references app.users (id) on delete set null,
  disabled_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Callback (redirect) URLs MCP clients may register. A pattern matches a URL exactly, except
-- that ":*" in the authority matches any port (RFC 8252 loopback redirects).
create table app.oauth_redirect_allowlist (
  id uuid primary key default gen_random_uuid(),
  pattern text not null unique check (pattern ~ '^https?://'),
  note text,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now()
);
insert into app.oauth_redirect_allowlist (pattern, note) values
  ('https://claude.ai/api/mcp/auth_callback', 'Claude (claude.ai)'),
  ('https://claude.com/api/mcp/auth_callback', 'Claude (claude.com)'),
  ('http://localhost:*/callback', 'Local MCP clients such as Claude Code'),
  ('http://127.0.0.1:*/callback', 'Local MCP clients such as Claude Code')
on conflict (pattern) do nothing;

create table app.oauth_codes (
  code_hash text primary key,
  client_id text not null references app.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null default '',
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tokens: API keys and OAuth access/refresh tokens. Only SHA-256 hashes are stored.
-- ---------------------------------------------------------------------------
create table app.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  kind text not null check (kind in ('api_key', 'oauth_access', 'oauth_refresh')),
  token_hash text not null unique,
  prefix text not null,
  name text,
  client_id text references app.oauth_clients (client_id) on delete cascade,
  scopes text[] not null default '{}',
  resource text,
  family_id uuid,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (kind = 'api_key' or client_id is not null)
);
create index api_tokens_user_idx on app.api_tokens (user_id, kind);
create index api_tokens_family_idx on app.api_tokens (family_id) where family_id is not null;

alter table app.oauth_clients enable row level security;
alter table app.oauth_redirect_allowlist enable row level security;
alter table app.oauth_codes enable row level security;
alter table app.api_tokens enable row level security;

-- Admins manage clients and the callback allowlist; everyone may read client names.
grant select, insert, update, delete on app.oauth_clients to app_user;
create policy oauth_clients_select on app.oauth_clients for select to app_user using (true);
create policy oauth_clients_admin on app.oauth_clients for all to app_user using (app.is_admin()) with check (app.is_admin());
grant select, insert, update, delete on app.oauth_redirect_allowlist to app_user;
create policy oauth_allowlist_select on app.oauth_redirect_allowlist for select to app_user using (app.is_admin());
create policy oauth_allowlist_admin on app.oauth_redirect_allowlist for all to app_user using (app.is_admin()) with check (app.is_admin());

-- Codes are handled by the service connection only.
-- Users see and revoke their own tokens; admins see and revoke all. The hash is never readable.
grant select (id, user_id, kind, prefix, name, client_id, scopes, resource, expires_at, last_used_at, revoked_at, created_at)
  on app.api_tokens to app_user;
grant update (revoked_at) on app.api_tokens to app_user;
create policy api_tokens_select on app.api_tokens for select to app_user
  using (user_id = app.current_user_id() or app.is_admin());
create policy api_tokens_revoke on app.api_tokens for update to app_user
  using (user_id = app.current_user_id() or app.is_admin())
  with check (user_id = app.current_user_id() or app.is_admin());

-- ---------------------------------------------------------------------------
-- Audit: which channel made the change (web, api, mcp, sync, system)
-- ---------------------------------------------------------------------------
alter table app.audit_log add column if not exists via text;
create index if not exists audit_log_actor_idx on app.audit_log (actor_user_id, created_at desc);
create index if not exists audit_log_created_idx on app.audit_log (created_at desc);
