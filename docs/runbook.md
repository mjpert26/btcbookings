# BTC Scheduler runbook

Operational procedures for the issues most likely to need a human. Each section lists symptoms, how to confirm, and how to fix. SQL runs against the production database (Supabase SQL editor, as `postgres`). Tables are in the `app` schema.

Useful views:

```sql
-- Jobs that need attention
select kind, status, count(*) from app.jobs where status in ('failed', 'dead') group by 1, 2 order by 1;

-- Recent attempts for one job
select attempt_no, response_code, error, created_at from app.job_attempts where job_id = '<job id>' order by attempt_no;
```

---

## Graph subscriptions lapsed

**Symptoms.** Busy time added in Outlook does not block slots until the 15-minute delta sync runs. Bookings deleted in Outlook are detected late. Admin overview shows connections with an expired subscription.

**Confirm.**

```sql
select u.email, c.status, c.subscription_id, c.subscription_expires_at, c.last_synced_at, c.last_error
from app.calendar_connections c join app.users u on u.id = c.user_id
where c.status = 'healthy' and (c.subscription_expires_at is null or c.subscription_expires_at < now() + interval '12 hours')
order by c.subscription_expires_at nulls first;
```

**Causes and fixes.**

1. *Renewal cron not running.* In Vercel, check **Project > Settings > Cron Jobs** for `/api/cron/graph-subscriptions` (every 6 hours) and its recent invocations. Cron jobs need the Pro plan and a correct `CRON_SECRET`. Run it by hand:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/graph-subscriptions`
2. *Notification URL unreachable.* Graph validates the notification URL when a subscription is created. It must be publicly reachable over HTTPS and answer the validation handshake within 10 seconds. Deployment protection (Vercel Authentication or password protection) on the production domain blocks this. Exclude `/api/graph/*` or turn off protection for production.
3. *Token problems.* A subscription cannot be renewed with a broken token. See "User token revoked" below.
4. *Missed notifications.* The delta cron (`/api/cron/graph-delta`, every 15 minutes) reconciles regardless, so a lapse delays updates by at most 15 minutes.

To force a fresh subscription for one user:

```sql
update app.calendar_connections set subscription_id = null, subscription_expires_at = null where user_id = '<user id>';
insert into app.jobs (kind, payload, idempotency_key) values ('graph_subscription_ensure', jsonb_build_object('userId', '<user id>'), 'manual:' || now());
```

---

## User token revoked

**Symptoms.** The user sees the "Reconnect Outlook" banner. Admins see the member flagged on the team page ("Skipped by round-robin until reconnected"). Outlook events for that user's new bookings fail with a "connection is broken" error.

**Confirm.**

```sql
select u.email, c.status, c.broken_at, c.last_error
from app.calendar_connections c join app.users u on u.id = c.user_id
where c.status <> 'healthy' order by c.broken_at desc;
```

**Causes.** Password reset with session revocation, consent revoked in My Apps or Entra, the Entra client secret expired (affects **everyone** at once), conditional access requiring MFA re-auth, or the account was disabled.

**Fix.**

1. Ask the user to click **Reconnect Outlook** (it signs them in again with a consent prompt). The connection returns to `healthy` and round-robin includes them again right away.
2. If many users broke at the same moment, check the Entra client secret expiry (**App registrations > BTC Scheduler > Certificates & secrets**) and the tenant-wide consent grant. Create a new secret, update `ENTRA_CLIENT_SECRET` in Vercel, redeploy, and ask users to reconnect.
3. Bookings made while the user was broken are still in the database. Their `graph_event_upsert` jobs are `dead`. After reconnecting, requeue them:

```sql
update app.jobs set status = 'pending', run_at = now(), max_attempts = attempts + 8
where kind = 'graph_event_upsert' and status = 'dead'
  and payload->>'bookingId' in (
    select b.id::text from app.bookings b join app.booking_hosts h on h.booking_id = b.id
    where h.user_id = '<user id>' and b.status = 'confirmed' and b.start_at > now());
```

---

## Queue sync stale or the safety rail tripped

**Symptoms.** The team admin page shows "Last synced" older than 10 minutes, sync health `stale` or `blocked`, or an open alert "Mass removal blocked".

**Stale (no snapshots arriving).**

1. In n8n (api.bigthinkcapital.com), open **BTC Scheduler - SF Queue Snapshot Poller** and check recent executions.
2. Common failures: the SF Token Broker returned no token (check the broker workflow and the JWT key file), SOQL errors (a queue ID that does not exist), or the app rejected the signature (`401`). The signature secret in n8n (`BTC_SCHEDULER_SIGNING_SECRET`) must equal `SF_SYNC_SIGNING_SECRET` in Vercel, and the n8n server clock must be within 5 minutes.
3. Use **Sync now** on the team page to trigger the poller once the cause is fixed.

**Safety rail tripped (`mass_removal_blocked`).** A snapshot would have paused more than the team's threshold (default 50%) of its active queue members, so nothing was applied.

1. Open the alert. It shows the counts.
2. Check the queue in Salesforce (**Setup > Queues > <queue>**). If the members really were removed (for example a reorganization), either lower the team's threshold temporarily, or pause the members by hand on the team page, then resolve the alert. The next snapshot then applies cleanly.
3. If the queue is intact, the snapshot was wrong (query failure, permission change on the n8n integration user, wrong queue ID). Fix the cause in n8n and resolve the alert. No membership changed, so nothing needs undoing.

---

## Slack removals blocked by workspace settings

**Symptoms.** A channel shows health `error` with "Workspace settings block removals by apps" (`restricted_action`). Invites still work.

**Cause.** The Slack workspace setting that controls who can remove members from channels does not allow the BTC Scheduler app to remove people.

**Fix.** A Slack Workspace Owner or Org Admin changes the setting: **Workspace settings > Permissions > Channel management > People who can remove members from public/private channels**. Allow the setting that includes apps (or "Everyone except guests" with the bot as a member). On Enterprise Grid this may be locked at the org level. After the change, open the channel on the team's Slack page and select **Full resync**.

Other per-channel states:

- `bot_not_in_channel`: private channels require the bot as a member. In Slack, open the channel and run `/invite @BTC Scheduler`, then select **Check health**.
- `missing_scope` / `invalid_auth`: the app was reinstalled with fewer scopes or the token changed. Reinstall from `slack/manifest.yml` and update `SLACK_BOT_TOKEN`.
- Rate limits are retried automatically using Slack's `Retry-After`.

---

## Salesforce lead jobs failing

**Symptoms.** Admin > Salesforce jobs shows `failed` or `dead` jobs. Bookings show "Lead: failed".

**Confirm.**

```sql
select j.id, j.status, j.attempts, j.last_error, b.invitee_email, b.created_at
from app.sf_lead_jobs j join app.bookings b on b.id = j.booking_id
where j.status in ('failed', 'dead') order by j.created_at desc;
```

**By error.**

- `401` from n8n: the signature failed. `N8N_SIGNING_SECRET` (Vercel) must equal `BTC_SCHEDULER_SIGNING_SECRET` (n8n), and the clocks must be within 5 minutes.
- `404` from n8n: the workflow **BTC Scheduler - SF Lead Create** is inactive or the webhook path changed (`N8N_LEAD_WEBHOOK_PATH`).
- `duplicate`: Salesforce duplicate rules or `DuplicateCheckHandler` matched an existing Lead. This is not retried. The booking stores the matched Lead ID when Salesforce returns one. Review the existing Lead. No retry is needed unless the rule was wrong.
- `REQUIRED_FIELD_MISSING` / `FIELD_CUSTOM_VALIDATION_EXCEPTION` / `INVALID_FIELD`: the event type's field mapping does not satisfy Lead validation. Fix it under **Admin > Event types > Salesforce**, then select **Retry**.
- Token errors inside n8n: check the **SF Token Broker** workflow (`7wen5ULQg7DBlCvC`) and the Redis cache key `sf:access_token`.

**Retry.** Use **Retry** in the admin UI (audited). Retries are idempotent: the booking ID is the idempotency key, and n8n skips bookings it already created a Lead for.

A booking never fails because Salesforce is down. The lead job waits in the outbox and retries with exponential backoff up to `SF_LEAD_MAX_ATTEMPTS`.
