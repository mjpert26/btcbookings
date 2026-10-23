-- Partner (team) page customization: display settings and an uploaded logo.
--
-- teams.page_settings holds display options for the team's public booking pages. The shape
-- is validated in application code (src/server/teams/page-settings.ts); the database only
-- requires a JSON object of bounded size. app.guard_team_admin_columns() lists the columns
-- that only global admins may change, and page_settings is not among them, so team admins
-- may update it for their own teams (the teams_update policy limits writes to app.is_team_admin).

alter table app.teams add column if not exists page_settings jsonb not null default '{}'::jsonb;
alter table app.teams drop constraint if exists teams_page_settings_object;
alter table app.teams add constraint teams_page_settings_object
  check (jsonb_typeof(page_settings) = 'object' and pg_column_size(page_settings) <= 8192);

-- One logo per team. Only raster formats are accepted (no SVG, which can carry script).
-- The bytes are served by /api/public/team-logo/[teamId] through the service connection;
-- signed-in users can read the metadata but never the bytes column.
create table app.team_logos (
  team_id uuid primary key references app.teams (id) on delete cascade,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  bytes bytea not null check (octet_length(bytes) between 1 and 524288),
  byte_size int generated always as (octet_length(bytes)) stored,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width int check (width is null or width between 1 and 10000),
  height int check (height is null or height between 1 and 10000),
  uploaded_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger team_logos_touch_updated_at before update on app.team_logos
  for each row execute function app.touch_updated_at();

alter table app.team_logos enable row level security;

grant select (team_id, content_type, byte_size, sha256, width, height, uploaded_by, created_at, updated_at)
  on app.team_logos to app_user;
grant insert (team_id, content_type, bytes, sha256, width, height, uploaded_by) on app.team_logos to app_user;
grant update (content_type, bytes, sha256, width, height, uploaded_by) on app.team_logos to app_user;
grant delete on app.team_logos to app_user;

create policy team_logos_select on app.team_logos for select to app_user
  using (app.is_team_admin(team_id) or app.is_manager());
create policy team_logos_insert on app.team_logos for insert to app_user
  with check (app.is_team_admin(team_id));
create policy team_logos_update on app.team_logos for update to app_user
  using (app.is_team_admin(team_id)) with check (app.is_team_admin(team_id));
create policy team_logos_delete on app.team_logos for delete to app_user
  using (app.is_team_admin(team_id));
