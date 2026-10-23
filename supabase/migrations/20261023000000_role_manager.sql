-- Manager role: read access to all bookings, booking pages, teams and the audit log, without
-- the right to change settings. A separate migration because a new enum value cannot be used
-- in the transaction that adds it.

alter type app.user_role add value if not exists 'manager';
