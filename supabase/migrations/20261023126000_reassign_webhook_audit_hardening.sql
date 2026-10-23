-- Review fixes for reassignment webhooks and the audit log.
--
-- 1. booking.reassigned webhook key: one dispatch per removal, not per (booking, user).
--    The key now includes the time the host was removed, so a booking that returns to a
--    host and is later moved away from them again still sends its event. The trigger still
--    fires only when reassigned_at goes from null to a value; the reassignment job sets it
--    only after another host has taken the booking.
-- 2. audit_log_insert: app_user may write entries only as itself, only through the web,
--    API or MCP channels, and booking entries only for bookings it can write. Sync, job,
--    webhook and public entries are written by the service connection.
-- 3. Webhook endpoint URLs are capability secrets for many receivers (Zapier, n8n, Slack),
--    and managers can read the audit log. Existing webhook audit entries are rewritten to
--    keep only the origin and a short hash of the full URL, the same form the app now
--    writes (src/server/webhooks/admin.ts, auditUrl()).

-- ---------------------------------------------------------------------------
-- 1. booking.reassigned idempotency key
-- ---------------------------------------------------------------------------
create or replace function app.booking_hosts_webhook_events() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  if old.reassigned_at is null and new.reassigned_at is not null and not exists (
    select 1 from app.bookings b where b.id = new.booking_id and b.import_source is not null
  ) then
    perform app.enqueue_booking_webhook(
      new.booking_id,
      'booking.reassigned',
      new.booking_id::text || ':webhook:reassigned:' || new.user_id::text || ':'
        || floor(extract(epoch from new.reassigned_at) * 1000000)::bigint::text
    );
  end if;
  return null;
end;
$$;
revoke all on function app.booking_hosts_webhook_events() from public;

-- ---------------------------------------------------------------------------
-- 2. audit_log_insert
-- ---------------------------------------------------------------------------
alter policy audit_log_insert on app.audit_log
  with check (
    actor_user_id = app.current_user_id()
    and (via is null or via in ('web', 'api', 'mcp'))
    and (entity_type is distinct from 'booking' or coalesce(app.can_write_booking(app.try_uuid(entity_id)), false))
  );

-- ---------------------------------------------------------------------------
-- 3. Mask webhook URLs already stored in the audit log
-- ---------------------------------------------------------------------------
update app.audit_log
set before = before || jsonb_build_object(
      'url', coalesce(substring(before ->> 'url' from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+'), '') || '/…',
      'urlHash', left(encode(sha256(convert_to(before ->> 'url', 'UTF8')), 'hex'), 12)
    )
where entity_type = 'webhook_endpoint'
  and jsonb_typeof(before -> 'url') = 'string'
  and not (before ? 'urlHash');

update app.audit_log
set after = after || jsonb_build_object(
      'url', coalesce(substring(after ->> 'url' from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+'), '') || '/…',
      'urlHash', left(encode(sha256(convert_to(after ->> 'url', 'UTF8')), 'hex'), 12)
    )
where entity_type = 'webhook_endpoint'
  and jsonb_typeof(after -> 'url') = 'string'
  and not (after ? 'urlHash');
