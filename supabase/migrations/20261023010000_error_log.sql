-- Application error log. Server errors (pages, route handlers, server actions, REST API, MCP,
-- jobs, cron) are grouped by fingerprint: a repeat of an unresolved error increments
-- occurrences and moves last_seen_at instead of adding a row. Messages, stacks and context are
-- sanitized before they are written (src/server/errors/sanitize.ts).
--
-- Writes come only from the service connection. Admins read the log and resolve or reopen
-- entries through app_user with RLS.

create table app.error_log (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('page', 'route', 'action', 'api', 'mcp', 'job', 'cron', 'client')),
  route text check (char_length(route) <= 300),
  method text check (char_length(method) <= 16),
  error_name text not null check (char_length(error_name) <= 120),
  message text not null check (char_length(message) <= 2000),
  stack text check (char_length(stack) <= 8000),
  digest text check (char_length(digest) <= 200),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  occurrences integer not null default 1 check (occurrences > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references app.users (id) on delete set null,
  check (resolved_by is null or resolved_at is not null),
  check (last_seen_at >= first_seen_at)
);

-- One open row per fingerprint. A resolved error that happens again opens a new row.
create unique index error_log_open_fingerprint_idx on app.error_log (fingerprint) where resolved_at is null;
create index error_log_last_seen_idx on app.error_log (last_seen_at desc);
create index error_log_source_idx on app.error_log (source, last_seen_at desc);
create index error_log_resolved_idx on app.error_log (resolved_at) where resolved_at is not null;

alter table app.error_log enable row level security;

-- app_user may read and change the resolution columns only. There is no insert or delete
-- grant: entries are written and purged by the service connection.
grant select on app.error_log to app_user;
grant update (resolved_at, resolved_by) on app.error_log to app_user;

create policy error_log_select on app.error_log for select to app_user using (app.is_admin());
create policy error_log_update on app.error_log for update to app_user
  using (app.is_admin()) with check (app.is_admin());
