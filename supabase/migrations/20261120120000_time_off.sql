-- Time off.
--
-- A time-off block makes a user unavailable on every booking page they host (personal pages
-- and team round-robin and collective pages), the same way an Outlook busy event does. Blocks
-- are either whole local days (all_day) or a time window, stored as UTC instants. `timezone`
-- is the zone used to interpret the input and is kept for display.
--
-- Access:
-- - Users read, add and delete their own blocks. They add them with created_by = themselves.
-- - Admins read, add and delete blocks for anyone (created_by = the admin).
-- - Managers read every block.
-- - Rows are never updated; a change is a delete followed by a new block.
-- The public booking engine reads user_id, starts_at and ends_at on the service connection.

create table app.time_off (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null,
  timezone text not null check (char_length(timezone) between 1 and 64),
  note text check (char_length(note) <= 200),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '366 days')
);

create index time_off_user_ends_idx on app.time_off (user_id, ends_at);

alter table app.time_off enable row level security;

grant select, insert, delete on app.time_off to app_user;

create policy time_off_select on app.time_off for select to app_user
  using (user_id = app.current_user_id() or app.is_manager());

create policy time_off_insert on app.time_off for insert to app_user
  with check (
    created_by = app.current_user_id()
    and (user_id = app.current_user_id() or app.is_admin())
  );

create policy time_off_delete on app.time_off for delete to app_user
  using (user_id = app.current_user_id() or app.is_admin());
