-- Slack channel sync: per-member action log.
--
-- One row per decision the Slack sync makes for a (channel config, team member) pair:
-- a real invite or kick, a dry-run "would do", a skip (protected user, #general, no
-- Slack account) or an error. Rows are written only by the job worker (service role).
-- Team admins and admins can read the rows for their teams.

create table app.slack_channel_actions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references app.teams (id) on delete cascade,
  -- Kept as null when the channel config is removed so the history survives.
  channel_config_id uuid references app.team_slack_channels (id) on delete set null,
  team_member_id uuid references app.team_members (id) on delete set null,
  channel_id text not null,
  slack_user_id text,
  action text not null check (action in ('invite', 'kick', 'skip')),
  dry_run boolean not null default false,
  outcome text not null check (outcome in ('done', 'would_do', 'skipped', 'error')),
  error_code text,
  detail text,
  created_at timestamptz not null default now()
);
create index slack_channel_actions_channel_idx on app.slack_channel_actions (channel_config_id, created_at desc);
create index slack_channel_actions_team_idx on app.slack_channel_actions (team_id, created_at desc);
create index slack_channel_actions_member_idx on app.slack_channel_actions (team_member_id, created_at desc);

alter table app.slack_channel_actions enable row level security;

grant select on app.slack_channel_actions to app_user;
create policy slack_channel_actions_select on app.slack_channel_actions for select to app_user
  using (app.is_team_admin(team_id));
