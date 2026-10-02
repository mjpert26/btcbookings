-- Microsoft Graph sync additions (Phase 2).
--
-- calendar_connections:
--   delta_window_start / delta_window_end  The calendarView window the stored delta link was
--                                          issued for. A delta link is bound to its window, so
--                                          when the rolling window moves the app runs a full
--                                          resync and stores a new link.
--   subscription_renewed_at                Last successful create or renew of the Graph
--                                          subscription (diagnostics).
--
-- The subscription clientState is never stored in plaintext. Only its SHA-256 hash is kept in
-- client_state_hash (existing column). Renewal uses PATCH expirationDateTime, which does not
-- need the clientState, and a recreated subscription gets a new random clientState, so the
-- plaintext never has to be recovered.
--
-- None of these columns are granted to app_user (the column-level grant in the RLS migration
-- lists the readable columns explicitly).

alter table app.calendar_connections
  add column delta_window_start timestamptz,
  add column delta_window_end timestamptz,
  add column subscription_renewed_at timestamptz;

-- Lookups from Outlook event ids back to bookings during delta reconciliation.
create index booking_hosts_graph_event_idx on app.booking_hosts (user_id, graph_event_id)
  where graph_event_id is not null;
create index booking_hosts_ical_uid_idx on app.booking_hosts (ical_uid) where ical_uid is not null;

-- Lets the delta job check for in-flight event writes for a booking.
create index jobs_kind_booking_idx on app.jobs (kind, booking_id) where booking_id is not null;
