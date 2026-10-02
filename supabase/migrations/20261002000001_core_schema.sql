-- BTC Scheduler core schema.
--
-- All application tables live in the "app" schema, which is NOT exposed through the
-- Supabase Data API (PostgREST). The application connects server-side only.
--
-- Access model:
--   * The connection role (postgres on Supabase) owns the tables and is used only by the
--     reviewed service module (webhooks, cron jobs, public booking engine).
--   * User-scoped requests run inside a transaction that executes
--       SET LOCAL ROLE app_user;
--       SELECT set_config('request.jwt.claims', '{"sub": "<user uuid>"}', true);
--     and are therefore subject to the RLS policies in the next migration.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end
$$;

grant usage on schema app to app_user;
grant app_user to current_user;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type app.user_role as enum ('user', 'admin');
create type app.connection_status as enum ('healthy', 'broken', 'disconnected');
create type app.membership_source as enum ('manual', 'salesforce_queue', 'queue_plus_manual');
create type app.member_status as enum ('active', 'paused', 'pending_onboarding');
create type app.member_origin as enum ('queue', 'manual');
create type app.membership_event_source as enum ('push', 'poll', 'manual', 'admin', 'system');
create type app.conflict_policy as enum ('auto_cancel', 'flag');
create type app.removal_policy as enum ('keep_bookings', 'reassign');
create type app.slack_mode as enum ('add_only', 'add_and_remove');
create type app.channel_health as enum ('unknown', 'ok', 'bot_not_in_channel', 'error');
create type app.location_type as enum ('teams', 'phone', 'in_person', 'custom');
create type app.scheduling_mode as enum ('individual', 'round_robin', 'collective');
create type app.rr_strategy as enum ('fairness', 'weighted', 'priority');
create type app.question_type as enum ('text', 'textarea', 'phone', 'email', 'dropdown', 'checkbox');
create type app.sf_owner_mode as enum ('assigned_host', 'fixed', 'assignment_rules');
create type app.booking_status as enum ('confirmed', 'cancelled', 'rescheduled', 'flagged');
create type app.booking_host_role as enum ('primary', 'collective');
create type app.job_status as enum ('pending', 'running', 'succeeded', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Returns the user id set for the current transaction, or null.
create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(
    coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'sub',
    ''
  )::uuid
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table app.users (
  id uuid primary key default gen_random_uuid(),
  entra_oid text unique,
  email citext not null unique,
  name text not null,
  timezone text not null default 'America/New_York',
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  languages text[] not null default '{en}',
  role app.user_role not null default 'user',
  photo_url text,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.admin_seeds (
  email citext primary key,
  note text,
  created_at timestamptz not null default now()
);

create table app.sessions (
  id text primary key,                         -- sha256 of the opaque cookie token
  user_id uuid not null references app.users (id) on delete cascade,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on app.sessions (user_id);

-- Short-lived state for the OIDC authorization code + PKCE flow.
create table app.oauth_states (
  state text primary key,                      -- sha256 of the state parameter
  code_verifier_enc text not null,
  nonce text not null,
  return_to text,
  purpose text not null default 'login',       -- 'login' | 'reconnect'
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table app.calendar_connections (
  user_id uuid primary key references app.users (id) on delete cascade,
  status app.connection_status not null default 'healthy',
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  subscription_id text unique,
  subscription_expires_at timestamptz,
  client_state_hash text,
  delta_link_enc text,
  last_synced_at timestamptz,
  last_error text,
  broken_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.busy_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  graph_event_id text not null,
  ical_uid text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  show_as text not null default 'busy',
  is_all_day boolean not null default false,
  booking_id uuid,
  updated_at timestamptz not null default now(),
  unique (user_id, graph_event_id),
  check (end_at > start_at)
);
create index busy_blocks_range_idx on app.busy_blocks using gist (user_id, tstzrange(start_at, end_at));

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
create table app.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  description text,
  membership_source app.membership_source not null default 'manual',
  outlook_conflict_policy app.conflict_policy not null default 'flag',
  removal_policy app.removal_policy not null default 'keep_bookings',
  mass_removal_threshold_pct int not null default 50 check (mass_removal_threshold_pct between 1 and 100),
  last_synced_at timestamptz,
  sync_health text not null default 'unknown',
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  user_id uuid references app.users (id) on delete set null,
  email citext not null,
  sf_user_id text,
  status app.member_status not null default 'active',
  source app.member_origin not null default 'manual',
  weight int not null default 1 check (weight between 0 and 1000),
  priority_tier int not null default 1 check (priority_tier between 1 and 10),
  daily_cap int check (daily_cap is null or daily_cap > 0),
  rr_assignment_count bigint not null default 0,
  rr_last_assigned_at timestamptz,
  paused_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, email)
);
create index team_members_user_idx on app.team_members (user_id);

create table app.team_admins (
  team_id uuid not null references app.teams (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table app.team_sf_queues (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  queue_id text not null check (queue_id ~ '^00G[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'),
  queue_name text,
  last_snapshot_at timestamptz,
  last_snapshot_hash text,
  created_at timestamptz not null default now(),
  unique (team_id, queue_id)
);

create table app.team_slack_channels (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{6,}$'),
  channel_name text,
  mode app.slack_mode not null default 'add_only',
  dry_run boolean not null default true,
  protected_slack_user_ids text[] not null default '{}',
  notify_channel_id text,
  health app.channel_health not null default 'unknown',
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, channel_id)
);

create table app.slack_identities (
  user_id uuid primary key references app.users (id) on delete cascade,
  slack_user_id text not null,
  resolved_at timestamptz not null default now()
);

create table app.membership_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  team_member_id uuid references app.team_members (id) on delete set null,
  email citext not null,
  old_status app.member_status,
  new_status app.member_status,
  source app.membership_event_source not null,
  actor_user_id uuid references app.users (id) on delete set null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index membership_events_team_idx on app.membership_events (team_id, created_at desc);

create table app.sync_alerts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references app.teams (id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}',
  resolved_at timestamptz,
  resolved_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
create table app.availability_schedules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references app.users (id) on delete cascade,
  owner_team_id uuid references app.teams (id) on delete cascade,
  name text not null default 'Working hours',
  timezone text not null default 'America/New_York',
  -- {"mon":[{"start":"09:30","end":"18:30"}], ... "sat":[], "sun":[]}
  weekly_rules jsonb not null default
    '{"mon":[{"start":"09:30","end":"18:30"}],"tue":[{"start":"09:30","end":"18:30"}],"wed":[{"start":"09:30","end":"18:30"}],"thu":[{"start":"09:30","end":"18:30"}],"fri":[{"start":"09:30","end":"18:30"}],"sat":[],"sun":[]}',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_user_id is null) <> (owner_team_id is null))
);
create unique index availability_one_default_per_user
  on app.availability_schedules (owner_user_id) where is_default and owner_user_id is not null;

create table app.availability_overrides (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references app.availability_schedules (id) on delete cascade,
  date date not null,
  intervals jsonb not null default '[]',      -- [] means unavailable all day
  created_at timestamptz not null default now(),
  unique (schedule_id, date)
);

create table app.user_settings (
  user_id uuid primary key references app.users (id) on delete cascade,
  unavailable_show_as text[] not null default '{busy,tentative,oof}',
  daily_booking_cap int check (daily_booking_cap is null or daily_booking_cap > 0),
  outlook_conflict_policy app.conflict_policy not null default 'flag',
  notify_host_by_email boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Event types
-- ---------------------------------------------------------------------------
create table app.event_types (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references app.users (id) on delete cascade,
  team_id uuid references app.teams (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  language text not null default 'en' check (language ~ '^[a-z]{2}$'),
  parent_event_type_id uuid references app.event_types (id) on delete cascade,
  overrides text[] not null default '{}',
  name text not null,
  description jsonb not null default '{}',     -- {"en": "...", "es": "..."}
  durations int[] not null default '{30}',
  default_duration int not null default 30,
  location_type app.location_type not null default 'teams',
  location_detail text,
  schedule_id uuid references app.availability_schedules (id) on delete set null,
  buffer_before_min int not null default 0 check (buffer_before_min between 0 and 240),
  buffer_after_min int not null default 0 check (buffer_after_min between 0 and 240),
  min_notice_min int not null default 240 check (min_notice_min >= 0),
  max_per_day int check (max_per_day is null or max_per_day > 0),
  booking_window_days int not null default 30 check (booking_window_days between 1 and 365),
  slot_interval_min int check (slot_interval_min is null or slot_interval_min between 5 and 240),
  scheduling_mode app.scheduling_mode not null default 'individual',
  rr_strategy app.rr_strategy not null default 'fairness',
  rr_sticky_returning_invitee boolean not null default false,
  reminder_offsets_min int[] not null default '{1440,60}',
  is_active boolean not null default true,
  is_listed boolean not null default true,
  brand_accent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_user_id is null) <> (team_id is null)),
  check (default_duration = any (durations)),
  check (
    (team_id is null and scheduling_mode = 'individual')
    or (team_id is not null and scheduling_mode in ('round_robin', 'collective'))
  ),
  check (parent_event_type_id is null or parent_event_type_id <> id)
);
create unique index event_types_user_slug_lang
  on app.event_types (owner_user_id, slug, language) where owner_user_id is not null;
create unique index event_types_team_slug_lang
  on app.event_types (team_id, slug, language) where team_id is not null;

-- Optional subset of team members eligible for a team event type (empty = whole team).
create table app.event_type_hosts (
  event_type_id uuid not null references app.event_types (id) on delete cascade,
  team_member_id uuid not null references app.team_members (id) on delete cascade,
  is_required boolean not null default true,
  weight_override int check (weight_override is null or weight_override between 0 and 1000),
  priority_tier_override int check (priority_tier_override is null or priority_tier_override between 1 and 10),
  primary key (event_type_id, team_member_id)
);

create table app.event_type_questions (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references app.event_types (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  type app.question_type not null,
  label jsonb not null,                        -- {"en": "Company name", "es": "Nombre de la empresa"}
  options jsonb not null default '[]',         -- [{"value": "x", "label": {"en": "...", "es": "..."}}]
  required boolean not null default false,
  position int not null default 0,
  unique (event_type_id, key)
);

create table app.event_type_sf_settings (
  event_type_id uuid primary key references app.event_types (id) on delete cascade,
  create_sf_lead boolean not null default false,
  field_mapping jsonb not null default '{}',   -- {"invitee_email": "Email", "q:company": "Company"}
  static_values jsonb not null default '{}',   -- {"csbs__ISO__c": "001...", "Status": "Open"}
  campaign_id text,
  owner_mode app.sf_owner_mode not null default 'assigned_host',
  owner_fixed_id text,
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  check (owner_mode <> 'fixed' or owner_fixed_id is not null)
);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table app.bookings (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references app.event_types (id) on delete restrict,
  language text not null default 'en',
  status app.booking_status not null default 'confirmed',
  start_at timestamptz not null,
  end_at timestamptz not null,
  invitee_name text not null,
  invitee_email citext not null,
  invitee_phone text,
  invitee_timezone text not null,
  location_type app.location_type not null,
  location_detail text,
  online_meeting_url text,
  manage_token_hash text not null unique,
  cancel_reason text,
  cancelled_by text,                            -- 'invitee' | 'host' | 'system'
  cancelled_at timestamptz,
  flagged_reason text,
  rescheduled_from_id uuid references app.bookings (id) on delete set null,
  sf_lead_id text,
  sf_lead_status text,                          -- null | 'pending' | 'created' | 'duplicate' | 'failed'
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index bookings_event_type_idx on app.bookings (event_type_id, start_at);
create index bookings_invitee_idx on app.bookings (invitee_email);

create table app.booking_hosts (
  booking_id uuid not null references app.bookings (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete restrict,
  team_member_id uuid references app.team_members (id) on delete set null,
  role app.booking_host_role not null default 'primary',
  blocked_range tstzrange not null,             -- booking time including buffers
  graph_event_id text,
  ical_uid text,
  active boolean not null default true,
  primary key (booking_id, user_id),
  -- The database-level guarantee against double booking a host.
  constraint booking_hosts_no_overlap
    exclude using gist (user_id with =, blocked_range with &&) where (active)
);
create index booking_hosts_user_idx on app.booking_hosts (user_id);

create table app.booking_answers (
  booking_id uuid not null references app.bookings (id) on delete cascade,
  question_id uuid references app.event_type_questions (id) on delete set null,
  question_key text not null,
  value text not null,
  primary key (booking_id, question_key)
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
create table app.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}',
  status app.job_status not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 8,
  run_at timestamptz not null default now(),
  locked_until timestamptz,
  idempotency_key text,
  last_error text,
  result jsonb,
  booking_id uuid references app.bookings (id) on delete set null,
  team_id uuid references app.teams (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, idempotency_key)
);
create index jobs_ready_idx on app.jobs (run_at) where status in ('pending', 'failed');
create index jobs_booking_idx on app.jobs (booking_id);

create table app.job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references app.jobs (id) on delete cascade,
  attempt_no int not null,
  request_summary jsonb,
  response_code int,
  error text,
  duration_ms int,
  created_at timestamptz not null default now()
);
create index job_attempts_job_idx on app.job_attempts (job_id, attempt_no);

create table app.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references app.users (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index audit_log_entity_idx on app.audit_log (entity_type, entity_id, created_at desc);

create table app.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

create table app.webhook_nonces (
  source text not null,
  nonce text not null,
  received_at timestamptz not null default now(),
  primary key (source, nonce)
);

-- Typed view over the Salesforce outbox for the admin UI.
create view app.sf_lead_jobs as
  select j.id, j.booking_id, j.status, j.attempts, j.max_attempts, j.run_at, j.last_error,
         j.result, j.created_at, j.updated_at, b.sf_lead_id, b.sf_lead_status, b.event_type_id
  from app.jobs j
  left join app.bookings b on b.id = j.booking_id
  where j.kind = 'sf_lead_create';

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'calendar_connections', 'teams', 'team_members', 'team_slack_channels',
    'availability_schedules', 'event_types', 'bookings', 'jobs', 'user_settings', 'busy_blocks',
    'event_type_sf_settings'
  ] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_updated_at()',
                   t || '_touch', t);
  end loop;
end
$$;
