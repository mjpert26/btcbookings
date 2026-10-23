-- Booking history: find the reschedule entry that created a booking through
-- app.bookings.rescheduled_from_id instead of the after ->> 'newBookingId' jsonb value.
--
-- Row-level security on app.audit_log runs before any user condition that is not leakproof,
-- and the jsonb ->> operator is not leakproof. A history query that filtered on
-- after ->> 'newBookingId' therefore checked the policy on every booking.reschedule entry in
-- the log for non-manager users. Booking timelines now look the entry up by entity_id (the
-- old booking's id, taken from rescheduled_from_id), which uses audit_log_entity_idx.
--
-- The policy follows the same rule: a reschedule entry is readable by whoever can read the
-- booking that replaced it, and that booking must both be named in the entry and record the
-- entry's booking as its rescheduled_from_id.

create or replace function app.can_read_booking_audit(p_entity_type text, p_entity_id text, p_action text, p_after jsonb)
returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select p_entity_type = 'booking' and (
    coalesce(app.can_read_booking(app.try_uuid(p_entity_id)), false)
    or (
      p_action = 'booking.reschedule'
      and exists (
        select 1 from app.bookings b
        where b.id = app.try_uuid(p_after ->> 'newBookingId')
          and b.rescheduled_from_id = app.try_uuid(p_entity_id)
          and app.can_read_booking(b.id)
      )
    )
  )
$$;
revoke all on function app.can_read_booking_audit(text, text, text, jsonb) from public;
grant execute on function app.can_read_booking_audit(text, text, text, jsonb) to app_user;

drop index if exists app.audit_log_rescheduled_to_idx;
