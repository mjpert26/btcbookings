-- Admin > Settings: Twilio as a text message provider.
--
-- Adds TWILIO_ACCOUNT_SID and TWILIO_FROM_NUMBER (plain) and TWILIO_AUTH_TOKEN (secret,
-- encrypted like the other secrets) to the keys app.integration_settings accepts. The
-- column grants and row-level security policies of the table are unchanged.

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
      'SF_SYNC_SIGNING_SECRET',
      'SF_QUEUE_PUSH_BEARER'
    ))
  );
