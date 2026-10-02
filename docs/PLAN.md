# BTC Scheduler: Implementation Plan

Status: **Approved 2026-10-02.** Build in progress. Decisions are recorded in section 13.

Owner: Mike Perticone. Last updated: 2026-10-02.

---

## 1. Summary

BTC Scheduler is a Big Think Capital branded scheduling platform that replaces Calendly. Employees sign in with Microsoft 365. Their Outlook calendars feed availability and receive every booking. Booking pages can belong to an individual or to a team, and team pages can use round-robin or collective assignment. Team rosters can be driven by Salesforce Queues, and roster changes are pushed to Slack channels. Booking pages come in English and Spanish variants that share Salesforce settings but route to different reps. A per-page admin toggle creates a Salesforce Lead through n8n.

## 2. Architecture

```
                         +-----------------------------+
 Invitee (browser) ----> |  Next.js on Vercel          |
 Employee (browser) ---> |  - App Router UI (RSC)      |
                         |  - Route handlers (/api/*)  |
                         |  - Server actions           |
                         +------+-----------+----------+
                                |           |
                 Postgres (Drizzle, pooled) |  outbound HTTPS
                                |           |
                    +-----------v--+     +--v------------------------------+
                    |  Supabase    |     | Microsoft Graph (calendar)      |
                    |  Postgres    |     | Resend (email)                  |
                    |  RLS on all  |     | Slack Web API (bot token)       |
                    |  tables      |     | n8n @ api.bigthinkcapital.com   |
                    +-----------^--+     |   -> Salesforce (JWT + broker)  |
                                |        +--^------------------------------+
                    Vercel Cron |           |
                 (every minute) |           | inbound, signed
                    +-----------+--+     +--+------------------------------+
                    | Job worker    |     | Graph change notifications     |
                    | (jobs outbox) |     | SF Flow / Apex queue push      |
                    +---------------+     | n8n queue snapshot poller      |
                                          +---------------------------------+
```

### 2.1 Key decisions

| Area | Decision | Reason |
|---|---|---|
| Framework | Next.js (App Router, TypeScript, strict mode) on Vercel | Requested stack. |
| Data access | Drizzle ORM over the Supabase pooler, server-side only | The booking flow needs real multi-statement transactions, row locks and advisory locks. `supabase-js` cannot run a transaction outside an RPC. |
| RLS enforcement | Every user-scoped query runs inside a transaction that executes `SET LOCAL ROLE authenticated` and `SET LOCAL request.jwt.claims = '{"sub": <user_id>, "app_role": ...}'`. Policies use `auth.uid()` and helper functions such as `is_admin()` and `is_team_admin(team_id)`. | RLS is the enforcement layer for employee data, not only a backstop. No Supabase JWT is minted or sent to the browser. |
| Privileged paths | Cron jobs, webhooks and the public booking engine run under a dedicated `app_service` role that has `BYPASSRLS`, and they only touch the database through a small, reviewed module (`src/server/service/*`). | Webhooks and public bookings act on behalf of no signed-in user. Keeping them in one module keeps the bypass auditable. |
| Public reads | Public pages read only from views that expose public-safe columns (`public_event_types_v`, `public_hosts_v`). | Prevents leaking Salesforce IDs, emails of non-assigned members, weights, or internal flags. |
| Auth | Custom Entra ID OIDC flow (authorization code + PKCE, confidential client) in route handlers. The app issues its own session: an httpOnly, Secure, SameSite=Lax cookie holding an opaque session ID that maps to a `sessions` row. | Supabase Auth's Azure provider returns the Graph refresh token only once and never refreshes it. One flow must produce both the login and a long-lived Graph token. |
| Token storage | Graph access and refresh tokens encrypted with AES-256-GCM (random 96-bit IV per value, key ID prefix to allow rotation). Key from `TOKEN_ENCRYPTION_KEY`. | Requested. Key ID prefix allows key rotation without downtime. |
| Times | Luxon. All timestamps stored as `timestamptz` (UTC). Availability rules stored as local wall-clock times plus an IANA zone, and expanded per date so DST is handled correctly. | Luxon's zone handling is explicit and testable. |
| i18n | `next-intl`. Locales defined in one config (`src/i18n/locales.ts`). Message catalogs in `messages/{locale}.json`. | Adding a language is a config and catalog change, not a code change. |
| Background work | One `jobs` table (outbox) with `kind`, `payload`, `status`, `attempts`, `run_at`, `locked_until`, `last_error`, `idempotency_key`. A Vercel Cron route runs every minute and claims work with `FOR UPDATE SKIP LOCKED`. Retries use exponential backoff with jitter. | Works on Vercel with no additional infrastructure. Requires the Vercel Pro plan for per-minute crons. |
| Rate limiting | Postgres-backed fixed-window counter keyed by IP hash plus route, plus a Vercel Firewall rate-limit rule on `/api/public/*`. | No Redis needed at BTC's traffic volume. The firewall rule stops floods before they reach the database. |
| Bot protection | Cloudflare Turnstile on the booking submit, reschedule and cancel forms. Verified server-side. | Requested. |
| Email | Resend with React Email templates, rendered per locale. | Requested. |
| Testing | Vitest for unit tests. Integration tests run against a real local Postgres (Supabase CLI) with Graph, Slack, Resend and n8n mocked through MSW. Playwright for a booking-flow smoke test. | The double-booking and assignment tests need real Postgres locking semantics. |

### 2.2 Repository layout

```
/src
  /app
    /(public)/[userSlug]/...            individual pages and booking flow
    /(public)/t/[teamSlug]/...          team pages and booking flow
    /(public)/b/[token]/...             reschedule and cancel (tokenized)
    /(app)/dashboard/...                host dashboard
    /(app)/admin/...                    admin and team admin pages
    /api/auth/*                         Entra sign-in, callback, sign-out
    /api/graph/notifications            Graph change notifications
    /api/sync/queue-membership          Salesforce push
    /api/sync/queue-snapshot            n8n poller snapshot
    /api/cron/*                         Vercel Cron entry points
    /api/public/*                       slots, book, reschedule, cancel
  /server
    /auth  /crypto  /db  /graph  /slack  /salesforce  /email
    /scheduling   slot engine, round-robin, collective (pure functions)
    /booking      booking transaction
    /sync         queue diffing, safety rail
    /jobs         worker and handlers
  /i18n  /theme  /components
/supabase/migrations                    SQL migrations, RLS policies
/n8n                                    importable workflow JSON
/docs                                   plan, runbook, n8n, Salesforce changes
/tests                                  unit and integration tests
/scripts/seed.ts
```

## 3. Data model

All primary keys are UUIDv4. Every table has `created_at` and `updated_at`. RLS is enabled on every table. Enums are Postgres enums.

### 3.1 Identity and access

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `entra_oid` (unique), `email` (citext, unique), `name`, `timezone`, `slug` (unique), `languages` (text[], e.g. `{en,es}`), `role` (`user` / `admin`), `photo_url`, `is_active` | `role` is global. Team admin rights live in `team_admins`. |
| `admin_seeds` | `email` | Emails promoted to `admin` on first login and on every login. Seeded from `ADMIN_EMAILS`. |
| `sessions` | `id` (opaque token hash), `user_id`, `expires_at`, `user_agent`, `ip_hash` | Server-side sessions. Revocable. |
| `calendar_connections` | `user_id`, `status` (`healthy` / `broken` / `disconnected`), `access_token_enc`, `refresh_token_enc`, `token_expires_at`, `scopes`, `subscription_id`, `subscription_expires_at`, `client_state_hash`, `delta_link_enc`, `last_synced_at`, `last_error` | One row per user in v1. |
| `busy_blocks` | `user_id`, `graph_event_id`, `ical_uid`, `start_at`, `end_at`, `show_as`, `is_all_day`, `booking_id` (nullable, set for the app's own events) | GiST index on `(user_id, tstzrange(start_at, end_at))`. |

### 3.2 Availability

| Table | Key columns | Notes |
|---|---|---|
| `availability_schedules` | `id`, `owner_user_id` or `owner_team_id`, `name`, `timezone`, `weekly_rules` (jsonb: per weekday, list of `{start: "09:30", end: "18:30"}`), `is_default` | Default template is America/New_York, 9:30 to 18:30, Monday to Friday. |
| `availability_overrides` | `schedule_id`, `date`, `intervals` (jsonb, empty means unavailable) | Date-specific overrides. |
| `user_settings` | `user_id`, `unavailable_show_as` (text[], default `{busy,tentative,oof}`), `default_schedule_id`, `daily_booking_cap` | Per-user setting for which Outlook states block time. |

### 3.3 Teams and sync

| Table | Key columns | Notes |
|---|---|---|
| `teams` | `id`, `name`, `slug`, `membership_source` (`manual` / `salesforce_queue` / `queue_plus_manual`), `outlook_conflict_policy` (`auto_cancel` / `flag`), `removal_policy` (`keep_bookings` / `reassign`), `mass_removal_threshold_pct` (default 50), `last_synced_at`, `sync_health` | |
| `team_members` | `team_id`, `user_id` (nullable until onboarded), `sf_user_id`, `email` (citext), `status` (`active` / `paused` / `pending_onboarding`), `source` (`queue` / `manual`), `weight` (default 1), `priority_tier` (default 1), `daily_cap`, `rr_assignment_count`, `rr_last_assigned_at`, `paused_reason` | Unique on `(team_id, email)`. Rows are never deleted by sync, so round-robin history survives pause and unpause. |
| `team_admins` | `team_id`, `user_id` | |
| `team_sf_queues` | `team_id`, `queue_id` (18-char Group ID), `queue_name`, `last_snapshot_at`, `last_snapshot_hash` | |
| `team_slack_channels` | `team_id`, `channel_id`, `channel_name`, `mode` (`add_only` / `add_and_remove`), `dry_run` (default true), `protected_slack_user_ids` (text[]), `notify_channel_id`, `health` (`ok` / `bot_not_in_channel` / `error`), `last_error` | |
| `slack_identities` | `user_id`, `slack_user_id`, `resolved_at` | Cache for `users.lookupByEmail`. |
| `membership_events` | `team_id`, `team_member_id`, `email`, `old_status`, `new_status`, `source` (`push` / `poll` / `manual` / `admin`), `actor_user_id`, `detail` (jsonb), `created_at` | Append-only. Feeds Slack jobs. |
| `sync_alerts` | `team_id`, `kind` (e.g. `mass_removal_blocked`), `detail`, `resolved_at`, `resolved_by` | Safety rail output. |

### 3.4 Event types and bookings

| Table | Key columns | Notes |
|---|---|---|
| `event_types` | `id`, `owner_user_id` or `team_id` (check constraint: exactly one), `slug`, `language` (`en` / `es`), `parent_event_type_id`, `overrides` (text[] of setting keys the variant overrides), `name`, `description` (jsonb per locale), `durations` (int[]), `default_duration`, `location_type` (`teams` / `phone` / `in_person` / `custom`), `location_detail`, `schedule_id`, `buffer_before_min`, `buffer_after_min`, `min_notice_min`, `max_per_day`, `booking_window_days`, `slot_interval_min`, `scheduling_mode` (`individual` / `round_robin` / `collective`), `rr_strategy` (`fairness` / `weighted` / `priority`), `rr_sticky_returning_invitee` (bool), `is_active`, `is_listed` | Unique on `(owner, slug, language)`. A variant row shares `slug` with its parent and differs by `language`. |
| `event_type_hosts` | `event_type_id`, `team_member_id`, `is_required` (collective), weight and tier overrides | Optional subset of a team's members per event type. Empty means the whole team. Variants define their own pool here. |
| `event_type_questions` | `event_type_id`, `key` (stable, used in SF mapping), `type` (`text` / `textarea` / `phone` / `email` / `dropdown` / `checkbox`), `label` (jsonb `{en, es}`), `options` (jsonb per locale), `required`, `position` | Variants inherit questions from the parent unless `questions` is in `overrides`. |
| `event_type_sf_settings` | `event_type_id`, `create_sf_lead` (default false), `field_mapping` (jsonb: source key to Lead field API name), `static_values` (jsonb), `campaign_id`, `owner_mode` (`assigned_host` / `fixed` / `assignment_rules`), `owner_fixed_id` | Variants read the parent's row unless they have their own row. Admin-only via RLS. |
| `bookings` | `id`, `event_type_id`, `language`, `status` (`confirmed` / `cancelled` / `rescheduled` / `flagged`), `start_at`, `end_at`, `invitee_name`, `invitee_email`, `invitee_phone`, `invitee_timezone`, `manage_token_hash`, `cancel_reason`, `rescheduled_from_id`, `sf_lead_id`, `sf_lead_status`, `idempotency_key` | Invitee links use a 32-byte random token. Only its SHA-256 hash is stored. |
| `booking_hosts` | `booking_id`, `user_id`, `role` (`primary` / `collective`), `blocked_range` (tstzrange including buffers), `graph_event_id`, `ical_uid`, `active` (bool) | **Exclusion constraint** `EXCLUDE USING gist (user_id WITH =, blocked_range WITH &&) WHERE (active)`. This makes a double booking of one host impossible at the database level. |
| `booking_answers` | `booking_id`, `question_id`, `question_key`, `value` | |
| `email_reminders` | `booking_id`, `offset_min`, `job_id` | Created per booking from the event type's reminder settings. |

### 3.5 Operations

| Table | Key columns | Notes |
|---|---|---|
| `jobs` | `id`, `kind` (`sf_lead_create`, `slack_invite`, `slack_kick`, `email_send`, `graph_event_upsert`, `graph_event_delete`, `graph_subscription_renew`, ...), `payload`, `status` (`pending` / `running` / `succeeded` / `failed` / `dead`), `attempts`, `max_attempts`, `run_at`, `locked_until`, `idempotency_key` (unique per kind), `last_error`, `result` | The user's `sf_lead_jobs` requirement is met by `jobs` rows of kind `sf_lead_create` plus `job_attempts`. A dedicated `sf_lead_jobs` view gives the admin UI a typed list. |
| `job_attempts` | `job_id`, `attempt_no`, `request_summary` (redacted), `response_code`, `error`, `duration_ms` | Secrets and tokens are stripped before writing. |
| `audit_log` | `actor_user_id`, `action`, `entity_type`, `entity_id`, `before`, `after`, `ip_hash`, `created_at` | Append-only (no update or delete grants). Written for every admin change in the security section. |
| `rate_limits` | `key`, `window_start`, `count` | |
| `webhook_nonces` | `source`, `nonce`, `received_at` | Replay protection. Rows older than the timestamp window are purged. |

## 4. Core algorithms

### 4.1 Slot generation (pure, unit-tested)

Inputs: the resolved event type settings, the schedule with overrides, busy blocks per candidate host, existing bookings, "now," and the invitee's zone (display only).

1. For each date in `[today + min_notice, today + booking_window_days]`, expand weekly rules and date overrides in the **schedule's zone** with Luxon. This produces UTC intervals and handles DST gaps (2:00 to 3:00 does not exist) and overlaps.
2. Step through each interval at `slot_interval_min`. A slot is `[t, t + duration]`. Its blocked range is `[t - buffer_before, t + duration + buffer_after]`.
3. A host is free if the blocked range does not intersect busy blocks whose `show_as` is in the host's unavailable set, or any active `booking_hosts.blocked_range`. All-day events are treated as busy for the whole local day only when their `show_as` is in the unavailable set.
4. Drop slots earlier than `now + min_notice` and hosts at their per-day cap (counted in the host's local day).
5. Mode rules: individual means the owner is free. Round-robin means at least one eligible member is free. Collective means every required member is free.

### 4.2 Round-robin assignment (inside the booking transaction)

Eligible: `team_members.status = 'active'`, the calendar connection is `healthy`, free at the slot, and under the daily cap.

- **Fairness:** pick the eligible member with the oldest `rr_last_assigned_at` (nulls first). Ties go to the lowest `rr_assignment_count`, then a stable hash.
- **Weighted:** pick the member whose `rr_assignment_count / weight` is lowest (a deterministic smooth weighted round-robin, not random). This gives exact long-run proportions and is testable.
- **Priority tiers:** restrict to the lowest-numbered tier that has an eligible member, then apply fairness within that tier.
- **Sticky returning invitee (optional):** if the invitee email has a prior booking on this team with a host who is eligible now, assign that host.
- **Reschedule:** prefer the original host if eligible, otherwise run the strategy again.

### 4.3 Booking transaction

```
BEGIN;
  -- 1. Serialize assignment decisions for this team (or host) briefly.
  SELECT pg_advisory_xact_lock(hashtext('assign:' || team_or_host_id));
  -- 2. Lock candidate member rows (prevents two bookings both choosing or skipping the same person).
  SELECT ... FROM team_members WHERE ... FOR UPDATE;
  -- 3. Re-check availability against busy_blocks and booking_hosts.
  -- 4. Choose host(s) with the strategy above.
  -- 5. INSERT bookings, booking_hosts (the exclusion constraint is the final guard), booking_answers.
  -- 6. UPDATE team_members SET rr_assignment_count = +1, rr_last_assigned_at = now().
  -- 7. INSERT jobs: graph_event_upsert, email_send (confirmation and reminders), sf_lead_create (if enabled).
COMMIT;
```

Before the transaction, the server calls Graph `getSchedule` for the candidate hosts (2-second timeout, cache fallback) and writes any new busy blocks, so the in-transaction check reflects Outlook. The Outlook event is created by a job right after commit, and the confirmation page waits up to about 3 seconds for the job so it can show the Teams link. If Graph is down, the booking still holds and the job retries.

### 4.4 Variant resolution

`resolveEventType(id)` loads the row and, if `parent_event_type_id` is set, merges it with the parent. Inherited keys come from the parent unless the key is listed in `overrides`. Inheritable groups: `sf_settings`, `durations`, `questions`, `branding`, `location`, `buffers`. Routing (`event_type_hosts`, `rr_strategy`, `schedule_id`, `scheduling_mode`) always belongs to the variant. The admin UI renders the same resolver output side by side, with an "inherited" or "overridden" badge on each field.

### 4.5 Queue snapshot diffing

Input: `{ queueId, members: [{ sfUserId, email, isActive }], snapshotAt }` for every linked queue.

1. Union members across all queues linked to a team. Drop inactive users (inactive counts as removed).
2. Compare with `team_members` where `source = 'queue'`. Manual members are never touched by sync.
3. Compute additions, removals (to `paused`) and reinstatements (to `active`, or `pending_onboarding` when there is no app user or no healthy calendar).
4. **Safety rail:** if removals exceed `mass_removal_threshold_pct` of current active queue members, write nothing. Create a `sync_alert` and notify admins.
5. Otherwise apply changes, write `membership_events` with `source = 'poll'`, and enqueue Slack jobs.
6. If `removal_policy = 'reassign'`, enqueue reassignment of the paused member's future bookings (round-robin again, update Outlook, notify the invitee).

Push events (`/api/sync/queue-membership`) apply the single change immediately, with `source = 'push'`. The poller remains the source of truth and corrects any drift.

## 5. Integrations

### 5.1 Microsoft Graph

- Delegated scopes as requested. `OnlineMeetings.ReadWrite` is not required to create Teams-enabled events (`isOnlineMeeting: true` and `onlineMeetingProvider: "teamsForBusiness"` work with `Calendars.ReadWrite`). It is included because it was requested. Admin consent is recommended so employees are not prompted and so tenant consent policies do not block sign-in.
- The booking ID is stored as a `singleValueExtendedProperty` (`String {<app GUID>} Name BtcBookingId`) so the app can find its own events via `$filter`.
- Subscriptions are on `/me/events`, with `clientState` as a random 32-byte secret per subscription (only its hash is stored). The validation handshake echoes `validationToken` as `text/plain`. **To verify in Phase 2:** the current maximum subscription lifetime for Outlook event resources, believed to be 10,080 minutes (about 7 days) for basic notifications. The renewal cron runs every 6 hours and renews anything expiring within 48 hours. `lifecycleNotificationUrl` handles `reauthorizationRequired` and `subscriptionRemoved`.
- Delta reconciliation runs every 15 minutes per user with `calendarView/delta` over a rolling window (today minus 1 day to the booking window maximum plus 7 days).
- Outlook-side change detection: if the app's event is deleted or moved, the booking is set to `cancelled` with invitee notice, or to `flagged` with a host and admin alert, per the team's (or individual's) `outlook_conflict_policy`.
- Collective events: a single Outlook event is created on the primary host's calendar with the other required hosts and the invitee as attendees. Each host gets it through the normal invite. This avoids several unrelated copies. See question 12.

### 5.2 Salesforce (via n8n only)

- **Lead create:** the app sends `POST {N8N_BASE_URL}/webhook/btc-scheduler/lead` with headers `X-BTC-Timestamp`, `X-BTC-Signature: sha256=HMAC(secret, timestamp + "." + rawBody)` and `Idempotency-Key: <bookingId>`. n8n verifies the signature and a 5-minute window, checks idempotency (in Redis, which the token broker already uses, with a Salesforce `External_Booking_Id__c` lookup as a second check if that field is added), gets a token from the existing broker sub-workflow, and calls `POST /sobjects/Lead` with `Sforce-Auto-Assign: TRUE` only for `assignment_rules` mode and `FALSE` otherwise. A `DUPLICATES_DETECTED` error or a `DuplicateCheckHandler` rejection returns `{status: "duplicate", leadId: <matched Id if available>, error}`. The response is always `{status, leadId, error}`.
- **Queue snapshot poller:** an n8n schedule trigger (every 2 minutes) reads the linked queue IDs from the app (`GET /api/sync/linked-queues`, HMAC-signed), runs `SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (...)` followed by `SELECT Id, Email, IsActive FROM User WHERE Id IN (SELECT UserOrGroupId FROM GroupMember WHERE GroupId IN (...))` (GroupMember has no User relationship) (nested public groups are expanded), and posts the snapshot.
- **Push path:** see question 8. Flow HTTP Callout cannot compute an HMAC natively.
- Deliverables: `docs/n8n-workflows.md`, `/n8n/sf-lead-create.json`, `/n8n/sf-queue-snapshot.json`, `docs/salesforce-changes.md` (Named Credential and External Credential, Flow HTTP Callout steps, and the minimal `QueueManagementController` change). Nothing is deployed to Salesforce by me.

### 5.3 Slack

- Bot scopes: `channels:read`, `groups:read`, `channels:manage`, `groups:write`, `users:read`, `users:read.email`, plus `channels:join` (lets the bot join public channels itself) and `chat:write` (admin notices).
- Errors are mapped per channel: `already_in_channel` is success, `not_in_channel` on the bot means `bot_not_in_channel` health with `/invite @BTC Scheduler` instructions, `cant_kick_self` and protected users are skipped, `restricted_action` is surfaced as "workspace settings block removals" with a runbook link, and `ratelimited` is retried after `Retry-After`.
- New channel configs start in dry-run mode. Dry-run jobs record the action they would take and show it in the admin UI.
- Direction is one-way: Salesforce Queue, then team status, then Slack.

## 6. Security

- RLS on every table. Policies: users read and write their own rows. Team admins read their teams' members, event types and bookings. Only `admin` can write `event_type_sf_settings`, `team_sf_queues`, `team_slack_channels`, `users.role` and manual membership overrides. `audit_log` and `membership_events` are insert-only.
- Public endpoints: Turnstile, rate limits, Zod validation of every field (server-side), UUIDs and opaque tokens only, uniform error messages (no "user not found" enumeration), and a CSRF check on server actions (Origin header).
- Inbound webhooks: Graph `clientState` comparison in constant time. HMAC with timestamp window (5 minutes) and nonce replay table for the queue push, queue snapshot and any n8n callback.
- Secrets live only in env vars (Vercel encrypted env). Graph tokens and delta links are encrypted in the database. The Slack bot token stays in Vercel env rather than the database in v1. See question 6.
- Content Security Policy, HSTS, and `server-only` imports on every secret-bearing module so they cannot be bundled for the client.

## 7. Phases

Each phase ends with: migrations applied to a Supabase branch, the app running, tests passing, a written report of what works and what does not, and a Jira update plus Confluence notes (or paste-ready text if those are unreachable).

| Phase | Scope | Exit criteria |
|---|---|---|
| 1. Foundation and auth | Scaffold, theme config with placeholders, env handling, migrations for identity tables and RLS helpers, Entra sign-in, session handling, encrypted tokens, refresh and revoked-consent handling, the Reconnect banner, roles and admin seeding, audit log. Entra registration guide. | A BTC user can sign in and out locally, a `users` row is created, tokens are encrypted in the database, a forced refresh failure shows the banner, and RLS tests pass. |
| 2. Outlook sync | Busy-block cache, getSchedule and calendarView reads, subscriptions, webhook, renewal cron, delta reconciliation, event create, update and delete with the extended property, Outlook-side change detection, job worker. | Mocked Graph integration tests pass. A live test against one real mailbox creates, moves and deletes an event and the cache follows. |
| 3. Booking pages | Slot engine, individual and team event types, round-robin strategies, collective mode, booking transaction, invitee flow, ICS, tokenized reschedule and cancel, Resend emails and reminders, host dashboard, distribution report. | The slot and strategy unit suites pass, the concurrent-booking race test passes, and an end-to-end booking works locally. |
| 4. Language variants | next-intl, translated public UI and emails, variant linkage, the resolver, side-by-side admin view, `/es` routes and switcher. | Inheritance and override tests pass. A Spanish booking routes to the Spanish pool. |
| 5. Queue sync | Push and snapshot endpoints, diffing, safety rail, pending onboarding, removal policies, sync health UI, the n8n poller JSON, Salesforce change instructions. | Diffing and safety rail tests pass, pause and unpause preserves round-robin state, and the poller runs against the production org read-only. |
| 6. Slack sync | Manifest, install guide, channel configs, dry run, invite and kick jobs, error surfacing, admin notices. | Slack job retry and error tests pass. A dry run against a real test channel shows the right diff. |
| 7. Salesforce Leads | SF settings UI, mapping, outbox jobs, HMAC client, retry, status UI, the n8n lead workflow JSON. | Outbox retry and idempotency tests pass. A test Lead is created in a sandbox (or in production with your approval). |
| 8. Branding and UI polish | Real brand assets, accessibility pass (axe), mobile pass, final docs, Jira and Confluence bodies. | WCAG AA contrast checks pass. Docs are complete. |

Branding is set up as a single theme file in Phase 1 so assets can be swapped in at any point. Phase 8 is only the polish pass.

## 8. Testing strategy

- **Unit (Vitest):** slot generation (zones, DST spring-forward and fall-back, buffers, minimum notice, overlapping and all-day busy blocks, booking window edges), each round-robin strategy and a 10,000-booking fairness simulation, collective intersection, variant resolution, HMAC signing and verification, AES-GCM round trip and tamper detection.
- **Integration (local Supabase Postgres, MSW mocks):** 50 concurrent bookings on one slot and one team (exactly the right number succeed, no host double-booked), queue snapshot diffing and the safety rail, pause and unpause round-robin state, Slack retries and error mapping, Salesforce outbox retry and idempotency, Graph notification handling, and RLS policy tests run as different roles.
- **End-to-end (Playwright, Chromium):** book, reschedule and cancel on an individual page and a round-robin page.
- **Seed script:** demo users, a queue-linked team and a manual team, an English event with a Spanish variant routed to a different pool, and sample bookings.

## 9. Out of scope for v1 (future work)

Payments. Google Calendar. SMS reminders (possibly SendBlue later). Routing forms and pre-booking qualification. Languages beyond English and Spanish (i18n is built so that adding one is configuration).

## 10. Risks

| Risk | Mitigation |
|---|---|
| Delegated Graph tokens break when a user's password changes or consent is revoked, so the app cannot write to that calendar. | Broken connections are detected on refresh, the user is skipped by round-robin, and a banner plus an admin alert are shown. Future option: application permission `Calendars.ReadWrite` limited to a mail-enabled security group via RBAC for Applications in Exchange Online, which removes per-user token fragility. |
| Vercel Hobby only allows daily crons. | Requires Vercel Pro (see question 2). |
| Slack workspace settings may block removals by bots. | `restricted_action` is surfaced per channel. The runbook covers the workspace setting change. |
| A bad SOQL result or API failure looks like a mass removal. | Safety rail (default 50 percent). |
| Spanish copy quality. | Strings are delivered in catalogs for a native-speaker review before launch. |

## 11. Open questions (blocking)

Sections above refer to these by number.

1. **Brand assets.** Logo files (SVG preferred; light and dark versions, plus a square mark for the favicon), primary, secondary and accent hex codes, and fonts (name and license, or Google Fonts equivalents).
2. **Domain and hosting.** Production hostname (for example `book.bigthinkcapital.com`), where DNS is managed, which Vercel team to use, and whether that team is on Pro. Pro is needed for per-minute crons.
3. **Supabase.** Which organization, and whether to create a new project (recommended, region `us-east-1`) or use an existing one. Creating a project may add cost, so I will not create it without your approval.
4. **Admins.** Global admin emails, and initial team admins per team.
5. **Teams and queues.** The production org has more than 500 Queues (mostly `Affiliate - ...`). Which ones map to which teams? Likely candidates: `SDR Round Robin`, `SDR Closer`, `Book 1`, `Book 2`, `Book 3`, `House Book`. Which team (or queue) is the Spanish-speaking pool?
6. **Slack.** Which workspace, whether it is Enterprise Grid, who can approve the app install, the admin notice channel, and whether keeping the bot token in Vercel env (encrypted by Vercel) is acceptable instead of storing it encrypted in the database.
7. **"Lead source" on Leads.** In BTC's org, "lead source" normally means the ISO (`csbs__ISO__c`, a lookup to Account), not the standard `LeadSource` picklist. Should booking-page Leads set `csbs__ISO__c` (which ISO Account?), `LeadSource`, or both? Static values will support either.
8. **Queue push authentication.** A Flow HTTP Callout cannot compute an HMAC signature without Apex. Options: (a) a static bearer secret held in an External Credential custom header, plus a timestamp in the body, with the 2-minute poller as the source of truth (recommended); (b) an invocable Apex signer; (c) the Flow calls an n8n webhook, which signs and forwards to the app. `QueueManagementController` can sign with `Crypto.generateMac` either way.
9. **Resend.** Is a sending domain already verified, and what From address should be used (for example `scheduling@bigthinkcapital.com`)?
10. **Entra.** Tenant ID, and who holds Global Administrator or Privileged Role Administrator rights to grant admin consent.
11. **n8n.** Confirm the target instance at `api.bigthinkcapital.com`, and the name or ID of the Salesforce token broker sub-workflow. A search on the MCP Host n8n connection for "token broker" found nothing, so it may be on a different instance or have another name.
12. **Collective events.** Is one Outlook event on the primary host's calendar, with the other hosts as attendees, acceptable? The alternative is a separate event on each host's calendar, which is noisier and harder to keep in sync.

## 12. Assumed defaults (non-blocking)

Reminders at 24 hours and 1 hour. Slot interval equals the duration, with a 15-minute minimum. Booking window 30 days. Minimum notice 4 hours. Outlook conflict policy `flag`. Removal policy `keep_bookings`. Queue poll every 2 minutes. Mass-removal threshold 50 percent. Job max attempts 8, with backoff from 30 seconds up to 1 hour.

## 13. Decisions (2026-10-02)

| # | Topic | Decision |
|---|---|---|
| 1 | Brand | Logos supplied (light PNG and a WebP). Colors sampled from the logo: BTC Blue `#0D66A5`, Sky `#22A4DC`, Navy `#0B3D66`. Fonts: Montserrat (headings), Inter (body). The supplied dark logo uses the same blue wordmark, so a white or reversed wordmark is still needed for dark backgrounds. |
| 2 | Hosting | Vercel. DNS and the custom domain come later; use the `*.vercel.app` URL until then. |
| 3 | Supabase | Project `btc-bookings` (ref `fnxezwdygbgrsrfqnoep`) in **BTC Org**, region us-west-2. Created in the dashboard on 2026-10-02 (the connector's create call timed out); all migrations applied and verified against the tested schema. |
| 4 | Admins | Global admins: Mike Perticone and Brian Weiss. Seeded in `app.admin_seeds` and `ADMIN_EMAILS`. |
| 5 | Queues | No fixed mapping. Admins enter Salesforce Queue IDs per team on the admin page. |
| 6 | Slack | Build the full feature now; workspace setup and install later. |
| 7 | Lead source | "Lead source" means the ISO (`csbs__ISO__c`, lookup to Account). The admin setting is an ISO Account ID. `LeadSource` remains available as a plain static value. |
| 8 | Queue push | BTC manages queue membership with a Screen Flow today. The 2-minute poller is the primary path. The push endpoint accepts HMAC (Apex/n8n) or a bearer secret plus timestamp (Flow HTTP Callout) and is documented as optional. |
| 9 | Resend | Later. Without `RESEND_API_KEY`, emails are logged instead of sent. |
| 10 | Entra | Later. Mike is the admin. Tenant ID `91e22286-3995-43b2-9197-481a21962994`. |
| 11 | n8n | api.bigthinkcapital.com. Token broker sub-workflow: **SF Token Broker** (`7wen5ULQg7DBlCvC`). Related live workflow: **Calendly — SF Meeting Booked (shared)** (`yVjvBOx5E3Zc36rX`), whose Lead field conventions the lead workflow mirrors. |
| 12 | Collective events | One Outlook event on the primary host's calendar with the other hosts as attendees. |
| — | UI | Use React Bits components (via MCP Host) for visual polish where they help. |
