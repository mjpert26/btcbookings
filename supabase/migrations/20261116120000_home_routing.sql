-- Public home page routing by email (Admin > Home page).
--
-- 1. Admin > Settings: adds N8N_LOOKUP_TOKEN (secret, encrypted like the other secrets) to the
--    keys app.integration_settings accepts. It is the bearer token the app sends to the n8n
--    account-manager lookup workflow. The column grants and policies of the table are unchanged.
--
-- 2. app.home_routing: a single row with the booking pages the home page sends visitors to
--    (the new-business pool page, the renewal page per Salesforce renewal book and a default
--    renewal page) and the Salesforce owner emails that never count as a visitor's account
--    manager (shared, queue-like and integration users). Admins read and change it under
--    row-level security; the public lookup reads it on the service connection.

alter table app.integration_settings
  drop constraint integration_settings_key_check,
  add constraint integration_settings_key_check check (key in (
    'RESEND_API_KEY',
    'SENDBLUE_API_KEY',
    'SENDBLUE_API_SECRET',
    'SENDBLUE_WEBHOOK_SECRET',
    'TWILIO_AUTH_TOKEN',
    'SLACK_BOT_TOKEN',
    'TURNSTILE_SECRET_KEY',
    'N8N_SIGNING_SECRET',
    'N8N_LOOKUP_TOKEN',
    'SF_SYNC_SIGNING_SECRET',
    'SF_QUEUE_PUSH_BEARER',
    'EMAIL_FROM',
    'SENDBLUE_FROM_NUMBER',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_FROM_NUMBER',
    'SLACK_ADMIN_NOTIFY_CHANNEL',
    'TURNSTILE_SITE_KEY'
  ));

-- Whether a key is secret is fixed by its name.
alter table app.integration_settings
  drop constraint integration_settings_secret_kind_check,
  add constraint integration_settings_secret_kind_check check (
    is_secret = (key in (
      'RESEND_API_KEY',
      'SENDBLUE_API_KEY',
      'SENDBLUE_API_SECRET',
      'SENDBLUE_WEBHOOK_SECRET',
      'TWILIO_AUTH_TOKEN',
      'SLACK_BOT_TOKEN',
      'TURNSTILE_SECRET_KEY',
      'N8N_SIGNING_SECRET',
      'N8N_LOOKUP_TOKEN',
      'SF_SYNC_SIGNING_SECRET',
      'SF_QUEUE_PUSH_BEARER'
    ))
  );

create table app.home_routing (
  -- Singleton: the only allowed primary key value is true.
  id boolean primary key default true check (id),
  new_business_event_type_id uuid references app.event_types (id) on delete set null,
  renewal_default_event_type_id uuid references app.event_types (id) on delete set null,
  -- Salesforce renewal book name (Account.Renewal_Book__c, for example "Book 1") -> event type id.
  renewal_books jsonb not null default '{}' check (jsonb_typeof(renewal_books) = 'object'),
  excluded_owner_emails citext[] not null default array[
    'jessica.marks@bigthinkcapital.com',
    'jessica.marks2@bigthinkcapital.com',
    'jessica.marks3@bigthinkcapital.com',
    'jessica.marks4@bigthinkcapital.com',
    'teamaxkap@bigthinkcapital.com',
    'teamdc@bigthinkcapital.com',
    'sdr.roundrobin@bigthinkcapital.com',
    'shaine@forml.ai'
  ]::citext[] check (cardinality(excluded_owner_emails) <= 200),
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create trigger home_routing_touch before update on app.home_routing
  for each row execute function app.touch_updated_at();

insert into app.home_routing (id) values (true);

alter table app.home_routing enable row level security;

-- Admins only. There is no delete: the row is kept and its values are cleared instead.
grant select on app.home_routing to app_user;
grant insert (id, new_business_event_type_id, renewal_default_event_type_id, renewal_books, excluded_owner_emails, updated_by)
  on app.home_routing to app_user;
grant update (new_business_event_type_id, renewal_default_event_type_id, renewal_books, excluded_owner_emails, updated_by)
  on app.home_routing to app_user;

create policy home_routing_select on app.home_routing for select to app_user
  using (app.is_admin());
create policy home_routing_insert on app.home_routing for insert to app_user
  with check (app.is_admin() and updated_by = app.current_user_id());
create policy home_routing_update on app.home_routing for update to app_user
  using (app.is_admin())
  with check (app.is_admin() and updated_by = app.current_user_id());
