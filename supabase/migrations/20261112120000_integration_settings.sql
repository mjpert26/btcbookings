-- Admin > Settings: third-party integration keys that admins can set in the app instead of
-- in the Vercel environment.
--
-- A row overrides the environment variable of the same name. Deleting the row falls back to
-- the environment. Bootstrap configuration (database URL, encryption key ring, Entra, cron
-- secret, IP hash salt, base URLs, admin and domain lists, n8n URLs) is never stored here.
--
-- Secret keys are encrypted with the app key ring (AAD: 'integration_setting:' || key) and
-- stored in value_enc, which app_user can write but never read. Only the last four
-- characters (last4) are readable, for display. Plain keys are stored in value_plain.
-- Decryption happens only on the service connection (src/server/settings/integrations.ts).

create table app.integration_settings (
  key text primary key check (key in (
    'RESEND_API_KEY',
    'SENDBLUE_API_KEY',
    'SENDBLUE_API_SECRET',
    'SENDBLUE_WEBHOOK_SECRET',
    'SLACK_BOT_TOKEN',
    'TURNSTILE_SECRET_KEY',
    'N8N_SIGNING_SECRET',
    'SF_SYNC_SIGNING_SECRET',
    'SF_QUEUE_PUSH_BEARER',
    'EMAIL_FROM',
    'SENDBLUE_FROM_NUMBER',
    'SLACK_ADMIN_NOTIFY_CHANNEL',
    'TURNSTILE_SITE_KEY'
  )),
  is_secret boolean not null,
  value_plain text check (char_length(value_plain) between 1 and 4096),
  value_enc text check (char_length(value_enc) between 1 and 32768),
  last4 text check (char_length(last4) between 1 and 4),
  updated_by uuid references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  -- Whether a key is secret is fixed by its name.
  constraint integration_settings_secret_kind_check check (
    is_secret = (key in (
      'RESEND_API_KEY',
      'SENDBLUE_API_KEY',
      'SENDBLUE_API_SECRET',
      'SENDBLUE_WEBHOOK_SECRET',
      'SLACK_BOT_TOKEN',
      'TURNSTILE_SECRET_KEY',
      'N8N_SIGNING_SECRET',
      'SF_SYNC_SIGNING_SECRET',
      'SF_QUEUE_PUSH_BEARER'
    ))
  ),
  -- Secrets use value_enc and last4 only; plain keys use value_plain only.
  constraint integration_settings_value_column_check check (
    (is_secret and value_enc is not null and last4 is not null and value_plain is null)
    or (not is_secret and value_plain is not null and value_enc is null and last4 is null)
  )
);

create trigger integration_settings_touch before update on app.integration_settings
  for each row execute function app.touch_updated_at();

alter table app.integration_settings enable row level security;

-- Admins read the metadata and plain values. The encrypted secret can be written but never
-- read back by app_user.
grant select (key, is_secret, value_plain, last4, updated_by, updated_at) on app.integration_settings to app_user;
grant insert (key, is_secret, value_plain, value_enc, last4, updated_by) on app.integration_settings to app_user;
grant update (value_plain, value_enc, last4, updated_by) on app.integration_settings to app_user;
grant delete on app.integration_settings to app_user;

create policy integration_settings_select on app.integration_settings for select to app_user
  using (app.is_admin());
create policy integration_settings_insert on app.integration_settings for insert to app_user
  with check (app.is_admin() and updated_by = app.current_user_id());
create policy integration_settings_update on app.integration_settings for update to app_user
  using (app.is_admin())
  with check (app.is_admin() and updated_by = app.current_user_id());
create policy integration_settings_delete on app.integration_settings for delete to app_user
  using (app.is_admin());
