-- Request log for the REST API (/api/v1) and the MCP server (/mcp). One row per authenticated
-- request: who made it, with which key or app, what was called, the status and the duration.
-- Request and response bodies are never stored. Rows are written by the service connection
-- after the response is sent and purged after 30 days.

create table app.api_request_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  via text not null check (via in ('api', 'mcp')),
  user_id uuid references app.users (id) on delete set null,
  token_id uuid references app.api_tokens (id) on delete set null,
  client_id text check (char_length(client_id) <= 200),
  method text not null check (char_length(method) <= 16),
  route text not null check (char_length(route) <= 300),
  rpc_methods text[] not null default '{}' check (cardinality(rpc_methods) <= 50),
  status integer not null check (status between 100 and 599),
  duration_ms integer not null check (duration_ms >= 0),
  ip_hash text check (char_length(ip_hash) <= 64)
);

create index api_request_log_created_idx on app.api_request_log (created_at desc);
create index api_request_log_user_idx on app.api_request_log (user_id, created_at desc);

alter table app.api_request_log enable row level security;

-- Users read their own requests; admins read all. Only the service connection writes.
grant select on app.api_request_log to app_user;
create policy api_request_log_select on app.api_request_log for select to app_user
  using (user_id = app.current_user_id() or app.is_admin());
