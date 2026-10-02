-- Smoke-test data for the internal UI e2e suite (tests/e2e/internal.spec.ts).
-- Loaded by scripts/e2e-internal-db.sh into a disposable database. Session tokens:
--   admin-smoke-token  Mike Perticone, global admin
--   user-smoke-token   Ana Lopez, team admin of Funding Advisors
--   broken-smoke-token Bob Smith, broken Outlook connection
insert into app.users (id, email, name, slug, role, timezone, languages) values
  ('11111111-1111-4111-8111-111111111111', 'mike.perticone@bigthinkcapital.com', 'Mike Perticone', 'mike-perticone', 'admin', 'America/New_York', '{en}'),
  ('22222222-2222-4222-8222-222222222222', 'ana.lopez@bigthinkcapital.com', 'Ana Lopez', 'ana-lopez', 'user', 'America/New_York', '{en,es}'),
  ('33333333-3333-4333-8333-333333333333', 'bob.smith@bigthinkcapital.com', 'Bob Smith', 'bob-smith', 'user', 'America/Chicago', '{en}'),
  ('44444444-4444-4444-8444-444444444444', 'carla.diaz@bigthinkcapital.com', 'Carla Diaz', 'carla-diaz', 'user', 'America/New_York', '{en,es}');

insert into app.calendar_connections (user_id, status, last_synced_at) values
  ('11111111-1111-4111-8111-111111111111', 'healthy', now() - interval '3 minutes'),
  ('22222222-2222-4222-8222-222222222222', 'healthy', now() - interval '5 minutes'),
  ('33333333-3333-4333-8333-333333333333', 'broken', now() - interval '2 days');

insert into app.sessions (id, user_id, expires_at) values
  (encode(sha256('admin-smoke-token'::bytea), 'hex'), '11111111-1111-4111-8111-111111111111', now() + interval '7 days'),
  (encode(sha256('user-smoke-token'::bytea), 'hex'), '22222222-2222-4222-8222-222222222222', now() + interval '7 days'),
  (encode(sha256('broken-smoke-token'::bytea), 'hex'), '33333333-3333-4333-8333-333333333333', now() + interval '7 days');

insert into app.teams (id, name, slug, description, membership_source, last_synced_at, sync_health) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Funding Advisors', 'funding-advisors', 'Inbound funding consultations', 'queue_plus_manual', now() - interval '2 minutes', 'ok'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Spanish Desk', 'spanish-desk', null, 'manual', null, 'unknown');

insert into app.team_members (id, team_id, user_id, email, status, source, weight, priority_tier, sf_user_id) values
  ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'ana.lopez@bigthinkcapital.com', 'active', 'queue', 2, 1, '005000000000001AAA'),
  ('a1000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'bob.smith@bigthinkcapital.com', 'active', 'queue', 1, 1, '005000000000002AAA'),
  ('a1000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '44444444-4444-4444-8444-444444444444', 'carla.diaz@bigthinkcapital.com', 'pending_onboarding', 'manual', 1, 2, null),
  ('a1000000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'ana.lopez@bigthinkcapital.com', 'paused', 'manual', 1, 1, null);

insert into app.team_admins (team_id, user_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');

insert into app.team_sf_queues (team_id, queue_id, queue_name, last_snapshot_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00G5e000001AbCdEAF', 'Funding Queue', now() - interval '2 minutes');

insert into app.team_slack_channels (team_id, channel_id, channel_name, mode, dry_run, health, last_error) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'C0123ABCD', 'funding-advisors', 'add_and_remove', true, 'bot_not_in_channel', 'not_in_channel');

insert into app.sync_alerts (team_id, kind, detail) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mass_removal_blocked', '{"removals": 5, "active": 6, "thresholdPct": 50}');

insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, detail) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000002', 'bob.smith@bigthinkcapital.com', null, 'active', 'poll', '{}');

insert into app.event_types (id, owner_user_id, slug, language, name, description, durations, default_duration) values
  ('e1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'intro-call', 'en', 'Intro call', '{"en": "A short introduction."}', '{15,30}', 30);
insert into app.event_types (id, owner_user_id, slug, language, parent_event_type_id, overrides, name, description, durations, default_duration) values
  ('e1000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'intro-call', 'es', 'e1000000-0000-4000-8000-000000000001', '{location}', 'Llamada de introducción', '{"es": "Una breve introducción."}', '{15,30}', 30);
insert into app.event_types (id, team_id, slug, language, name, scheduling_mode, rr_strategy, durations, default_duration) values
  ('e1000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'consultation', 'en', 'Funding consultation', 'round_robin', 'weighted', '{30,45}', 30);

insert into app.event_type_questions (event_type_id, key, type, label, required, position) values
  ('e1000000-0000-4000-8000-000000000001', 'company', 'text', '{"en": "Company name", "es": "Nombre de la empresa"}', true, 0),
  ('e1000000-0000-4000-8000-000000000001', 'revenue', 'dropdown', '{"en": "Monthly revenue", "es": "Ingresos mensuales"}', false, 1);
update app.event_type_questions set options = '[{"value": "lt50k", "label": {"en": "Under $50k", "es": "Menos de $50k"}}, {"value": "gt50k", "label": {"en": "$50k or more", "es": "$50k o más"}}]' where key = 'revenue';

insert into app.event_type_sf_settings (event_type_id, create_sf_lead, field_mapping, static_values) values
  ('e1000000-0000-4000-8000-000000000003', true, '{"invitee_email": "Email", "invitee_last_name": "LastName"}', '{"csbs__ISO__c": "0015e00000AbCdEAAV", "Status": "Open"}');

insert into app.bookings (id, event_type_id, language, status, start_at, end_at, invitee_name, invitee_email, invitee_timezone, location_type, manage_token_hash, sf_lead_status) values
  ('b1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'en', 'confirmed', date_trunc('hour', now()) + interval '1 day 2 hours', date_trunc('hour', now()) + interval '1 day 2 hours 30 minutes', 'Jordan Reyes', 'jordan@example.com', 'America/Los_Angeles', 'teams', 'h1', null),
  ('b1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'en', 'confirmed', date_trunc('hour', now()) + interval '2 days 3 hours', date_trunc('hour', now()) + interval '2 days 3 hours 30 minutes', 'Priya Shah', 'priya@example.com', 'America/New_York', 'teams', 'h2', 'failed'),
  ('b1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', 'en', 'confirmed', date_trunc('hour', now()) - interval '5 days', date_trunc('hour', now()) - interval '5 days' + interval '30 minutes', 'Sam Lee', 'sam@example.com', 'America/New_York', 'phone', 'h3', 'created'),
  ('b1000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000003', 'en', 'flagged', date_trunc('hour', now()) + interval '3 days', date_trunc('hour', now()) + interval '3 days 30 minutes', 'Alex Kim', 'alex@example.com', 'America/Chicago', 'teams', 'h4', null);
update app.bookings set flagged_reason = 'The Outlook event was moved by the host.' where id = 'b1000000-0000-4000-8000-000000000004';

insert into app.booking_hosts (booking_id, user_id, team_member_id, blocked_range, graph_event_id) select
  b.id, h.user_id, h.tm, tstzrange(b.start_at, b.end_at), h.ge
from (values
  ('b1000000-0000-4000-8000-000000000001'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, null::uuid, 'AAMk1'),
  ('b1000000-0000-4000-8000-000000000002'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid, null),
  ('b1000000-0000-4000-8000-000000000003'::uuid, '33333333-3333-4333-8333-333333333333'::uuid, 'a1000000-0000-4000-8000-000000000002'::uuid, 'AAMk3'),
  ('b1000000-0000-4000-8000-000000000004'::uuid, '33333333-3333-4333-8333-333333333333'::uuid, 'a1000000-0000-4000-8000-000000000002'::uuid, 'AAMk4')
) as h(bid, user_id, tm, ge) join app.bookings b on b.id = h.bid;

insert into app.booking_answers (booking_id, question_key, value) values
  ('b1000000-0000-4000-8000-000000000001', 'company', 'Reyes Logistics LLC');
update app.booking_answers a set question_id = q.id from app.event_type_questions q where q.key = a.question_key and q.event_type_id = 'e1000000-0000-4000-8000-000000000001';

insert into app.jobs (kind, payload, status, attempts, last_error, booking_id, idempotency_key) values
  ('sf_lead_create', '{"bookingId": "b1000000-0000-4000-8000-000000000002"}', 'dead', 8, 'n8n returned 502 Bad Gateway', 'b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002'),
  ('sf_lead_create', '{"bookingId": "b1000000-0000-4000-8000-000000000003"}', 'succeeded', 1, null, 'b1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000003');
update app.bookings set sf_lead_id = '00Q5e00000XyZaBEAV' where id = 'b1000000-0000-4000-8000-000000000003';

insert into app.audit_log (actor_user_id, action, entity_type, entity_id, after) values
  ('11111111-1111-4111-8111-111111111111', 'user.promote_admin', 'user', '11111111-1111-4111-8111-111111111111', '{"role": "admin"}');

-- Attempt history for the dead lead job.
insert into app.job_attempts (job_id, attempt_no, response_code, error, duration_ms, created_at)
select j.id, n, 502, 'n8n returned 502 Bad Gateway', 180 + n * 10, now() - make_interval(hours => 9 - n)
from app.jobs j, generate_series(1, 8) n
where j.kind = 'sf_lead_create' and j.status = 'dead';
