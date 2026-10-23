-- Outbound webhooks: admins register HTTPS endpoints that receive signed booking events.
--
-- Booking changes are detected by triggers on app.bookings and app.booking_hosts, so every
-- code path (invitee, host, Outlook conflict, reschedule, reassignment, REST API, MCP) is
-- covered. A trigger adds one webhook_dispatch job per booking event, and only when an
-- enabled endpoint subscribes to that event. Imported Calendly bookings never produce events.
-- The dispatch handler records one delivery per matching endpoint and enqueues its
-- webhook_deliver job.

create table app.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  url text not null check (url ~ '^https://' and char_length(url) <= 2000),
  description text check (char_length(description) <= 200),
  events text[] not null check (
    cardinality(events) between 1 and 4
    and events <@ array['booking.created', 'booking.rescheduled', 'booking.cancelled', 'booking.reassigned']::text[]
  ),
  -- Only bookings on this partner's (team's) pages; null for all bookings.
  team_id uuid references app.teams (id) on delete cascade,
  -- Signing secret, encrypted with the app key ring (AAD: endpoint id). Never readable by app_user.
  secret_enc text not null,
  secret_prefix text not null check (char_length(secret_prefix) <= 20),
  enabled boolean not null default true,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_delivery_at timestamptz,
  last_status integer,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0)
);

create trigger webhook_endpoints_touch before update on app.webhook_endpoints
  for each row execute function app.touch_updated_at();

create table app.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references app.webhook_endpoints (id) on delete cascade,
  -- Shared by every endpoint's delivery of the same booking event.
  event_id uuid not null,
  event text not null check (event in ('booking.created', 'booking.rescheduled', 'booking.cancelled', 'booking.reassigned', 'webhook.test')),
  booking_id uuid references app.bookings (id) on delete set null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  response_status integer,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (endpoint_id, event_id)
);
create index webhook_deliveries_created_idx on app.webhook_deliveries (created_at desc);
create index webhook_deliveries_endpoint_idx on app.webhook_deliveries (endpoint_id, created_at desc);

alter table app.webhook_endpoints enable row level security;
alter table app.webhook_deliveries enable row level security;

-- Admins manage endpoints. The encrypted secret can be written but never read back.
grant select (id, url, description, events, team_id, secret_prefix, enabled, created_by, created_at, updated_at,
              last_delivery_at, last_status, consecutive_failures)
  on app.webhook_endpoints to app_user;
grant insert (id, url, description, events, team_id, secret_enc, secret_prefix, enabled, created_by) on app.webhook_endpoints to app_user;
grant update (url, description, events, team_id, secret_enc, secret_prefix, enabled) on app.webhook_endpoints to app_user;
grant delete on app.webhook_endpoints to app_user;
create policy webhook_endpoints_admin on app.webhook_endpoints for all to app_user
  using (app.is_admin()) with check (app.is_admin());

-- Deliveries contain booking details: admins read them; only the service connection writes.
grant select on app.webhook_deliveries to app_user;
create policy webhook_deliveries_select on app.webhook_deliveries for select to app_user using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Event detection
-- ---------------------------------------------------------------------------
create or replace function app.enqueue_booking_webhook(p_booking_id uuid, p_event text, p_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  if not exists (select 1 from app.webhook_endpoints e where e.enabled and p_event = any (e.events)) then
    return;
  end if;
  insert into app.jobs (kind, payload, idempotency_key, booking_id, max_attempts)
  values (
    'webhook_dispatch',
    jsonb_build_object('bookingId', p_booking_id, 'event', p_event, 'eventId', gen_random_uuid(), 'occurredAt', now()),
    p_key,
    p_booking_id,
    5
  )
  on conflict (kind, idempotency_key) do nothing;
end;
$$;
revoke all on function app.enqueue_booking_webhook(uuid, text, text) from public;

create or replace function app.bookings_webhook_events() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  if new.import_source is not null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.status in ('confirmed', 'flagged') then
      perform app.enqueue_booking_webhook(
        new.id,
        case when new.rescheduled_from_id is null then 'booking.created' else 'booking.rescheduled' end,
        new.id::text || ':webhook:created'
      );
    end if;
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform app.enqueue_booking_webhook(new.id, 'booking.cancelled', new.id::text || ':webhook:cancelled');
  end if;
  return null;
end;
$$;
revoke all on function app.bookings_webhook_events() from public;

create trigger bookings_webhook_events
  after insert or update of status on app.bookings
  for each row execute function app.bookings_webhook_events();

create or replace function app.booking_hosts_webhook_events() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  if old.reassigned_at is null and new.reassigned_at is not null and not exists (
    select 1 from app.bookings b where b.id = new.booking_id and b.import_source is not null
  ) then
    perform app.enqueue_booking_webhook(
      new.booking_id,
      'booking.reassigned',
      new.booking_id::text || ':webhook:reassigned:' || new.user_id::text
    );
  end if;
  return null;
end;
$$;
revoke all on function app.booking_hosts_webhook_events() from public;

create trigger booking_hosts_webhook_events
  after update of reassigned_at on app.booking_hosts
  for each row execute function app.booking_hosts_webhook_events();
