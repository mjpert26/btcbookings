-- Consent for merchant text reminders.
--
-- When a booking page sends merchant reminders by text (merchant_reminder_channels
-- contains 'sms'), the public booking form shows a disclosure and an unchecked consent
-- checkbox next to the phone field. sms_consent_at records when the invitee agreed. The
-- sms_send job sends merchant texts only when it is set, so existing bookings (all null)
-- never start receiving texts. A reschedule copies the value to the new booking.

alter table app.bookings add column sms_consent_at timestamptz;

comment on column app.bookings.sms_consent_at is
  'When the invitee agreed to receive reminder texts at invitee_phone. Null: no merchant texts.';

-- app_user has column-level SELECT on app.bookings (see 20261002600000_booking.sql).
grant select (sms_consent_at) on app.bookings to app_user;
