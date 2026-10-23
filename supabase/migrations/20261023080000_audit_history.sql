-- Audit history for bookings and settings (BTCSCHED-46, 47, 48).
--
-- 1. Agents read the audit history of bookings they can read. Managers and admins keep
--    reading every entry through audit_log_select (app.is_manager()). Permissive policies
--    are combined with OR, so this policy only adds rows.
-- 2. A booking.reschedule entry is recorded on the booking that was moved and names the new
--    booking in after.newBookingId. Whoever can read the new booking can read that entry too,
--    so the new booking's timeline shows where it came from.
-- 3. audit_log.via gains 'public' (invitee actions on the public booking pages). The check
--    is NOT VALID so existing rows are not rescanned; new rows are checked.

-- Returns the uuid for a canonical uuid string and null for anything else, so policies can
-- cast text ids without raising on malformed values.
create or replace function app.try_uuid(p text) returns uuid
language sql immutable parallel safe set search_path = app, pg_temp as $$
  select case
    when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid
    else null
  end
$$;
revoke all on function app.try_uuid(text) from public;
grant execute on function app.try_uuid(text) to app_user;

-- True when the caller can read the booking an audit entry belongs to.
create or replace function app.can_read_booking_audit(p_entity_type text, p_entity_id text, p_action text, p_after jsonb)
returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select p_entity_type = 'booking' and (
    coalesce(app.can_read_booking(app.try_uuid(p_entity_id)), false)
    or (
      p_action = 'booking.reschedule'
      and coalesce(app.can_read_booking(app.try_uuid(p_after ->> 'newBookingId')), false)
    )
  )
$$;
revoke all on function app.can_read_booking_audit(text, text, text, jsonb) from public;
grant execute on function app.can_read_booking_audit(text, text, text, jsonb) to app_user;

create policy audit_log_booking_select on app.audit_log for select to app_user
  using (app.can_read_booking_audit(entity_type, entity_id, action, after));

alter table app.audit_log
  add constraint audit_log_via_check
  check (via is null or via in ('web', 'api', 'mcp', 'sync', 'system', 'public')) not valid;

-- Booking timelines look up the reschedule entry that created a booking.
create index if not exists audit_log_rescheduled_to_idx on app.audit_log ((after ->> 'newBookingId'))
  where action = 'booking.reschedule';

-- Viewer: action prefix filter and keyset pagination.
create index if not exists audit_log_action_idx on app.audit_log (action text_pattern_ops, created_at desc);
create index if not exists audit_log_created_id_idx on app.audit_log (created_at desc, id desc);
