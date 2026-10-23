-- Reminder channels for merchants (invitees) and agents (hosts), and SMS opt-outs.
--
-- Defaults keep the previous behaviour: invitees get email reminders at
-- reminder_offsets_min, and nothing else is sent until a page enables it.
--
-- Like reminder_offsets_min, these settings belong to each event type row (they are not
-- an inheritable group). A Spanish variant copies them from its parent when it is created
-- and can be changed on its own afterwards.

alter table app.event_types
  add column merchant_reminder_channels text[] not null default '{email}',
  add column agent_reminder_channels text[] not null default '{}',
  add column agent_reminder_offsets_min int[] not null default '{15}';

alter table app.event_types
  add constraint event_types_merchant_reminder_channels_check
    check (merchant_reminder_channels <@ array['email', 'sms']::text[]),
  add constraint event_types_agent_reminder_channels_check
    check (agent_reminder_channels <@ array['email', 'slack', 'sms']::text[]),
  add constraint event_types_agent_reminder_offsets_check
    check (
      cardinality(agent_reminder_offsets_min) <= 8
      and 0 < all (agent_reminder_offsets_min)
      and 10080 >= all (agent_reminder_offsets_min)
    );

-- Mobile number for agent text reminders, in E.164 (for example +15551234567).
alter table app.user_settings
  add column sms_phone text check (sms_phone is null or sms_phone ~ '^\+[1-9][0-9]{7,14}$');

-- ---------------------------------------------------------------------------
-- SMS opt-outs
-- ---------------------------------------------------------------------------
-- One row per phone number that replied STOP (or an equivalent keyword). A START reply
-- deletes the row. The SMS job never sends to a number listed here. Rows are written
-- only by the service role (inbound webhook); admins can read them.
create table app.sms_opt_outs (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  keyword text not null,
  source text not null default 'inbound' check (source in ('inbound', 'admin')),
  opted_out_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sms_opt_outs_touch before update on app.sms_opt_outs
  for each row execute function app.touch_updated_at();

alter table app.sms_opt_outs enable row level security;

grant select on app.sms_opt_outs to app_user;
create policy sms_opt_outs_select on app.sms_opt_outs for select to app_user
  using (app.is_admin());
