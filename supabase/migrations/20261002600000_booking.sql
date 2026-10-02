-- Booking service additions.
--
-- 1. bookings.manage_token_enc holds the invitee's manage token encrypted with AES-256-GCM
--    (aad = booking id) so that emails sent later (reminders, reschedule notices) can
--    include the manage link. Only the service module reads it. The plain token is never
--    stored; manage_token_hash remains the lookup key.
-- 2. app_user previously had table-level SELECT on app.bookings. Table-level SELECT would
--    include the new column, so it is replaced by an explicit column list that omits
--    manage_token_enc. RLS policies are unchanged.
--
-- Consequence for application code running as app_user: "select *" and "returning *" on
-- app.bookings fail with "permission denied". List the columns explicitly.

alter table app.bookings add column if not exists manage_token_enc text;

revoke select on app.bookings from app_user;
grant select (
  id, event_type_id, language, status, start_at, end_at,
  invitee_name, invitee_email, invitee_phone, invitee_timezone,
  location_type, location_detail, online_meeting_url, manage_token_hash,
  cancel_reason, cancelled_by, cancelled_at, flagged_reason, rescheduled_from_id,
  sf_lead_id, sf_lead_status, idempotency_key, created_at, updated_at
) on app.bookings to app_user;

-- Reschedule chains and sticky round-robin lookups.
create index if not exists bookings_rescheduled_from_idx on app.bookings (rescheduled_from_id)
  where rescheduled_from_id is not null;
