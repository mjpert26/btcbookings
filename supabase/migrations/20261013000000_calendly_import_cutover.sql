-- Calendly import cutover.
--
-- Imported event types are created inactive. import_meta keeps Calendly's own flags
-- ({"active": bool, "secret": bool, "kind": "solo" | "group"}) so an admin can take exactly
-- the pages that were live in Calendly live here, per rep, per team or all at once.

alter table app.event_types add column if not exists import_meta jsonb;
