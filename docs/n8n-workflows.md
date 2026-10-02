# n8n workflows

## Queue snapshot poller

File: `n8n/sf-queue-snapshot-poller.json`. Workflow name: `BTC Scheduler - SF Queue Snapshot Poller`. Target instance: `https://api.bigthinkcapital.com`.

The poller is the source of truth for Salesforce Queue membership. Every 2 minutes it reads the members of every queue linked to a BTC Scheduler team and posts a full snapshot to the app, which diffs it against `team_members` (see PLAN 4.5). A push from Salesforce is optional (see `docs/salesforce-changes.md`).

### Flow

```
Every 2 Minutes ─────────────────────────────┐
Sync Now Webhook → Verify Sync Now Signature │
  → Signature Valid? ── no → Respond 401     │
                    └─ yes → Respond 202 ────┤
                                             ▼
Sign Linked Queues Request → Get Linked Queues → Has Linked Queues? (no: stop)
  → Build Queue Member Query → Get SF Token (SF Token Broker 7wen5ULQg7DBlCvC)
  → Query Queue Members (paginated) → Collect Members → Has Nested Groups?
       ├─ yes → Query Nested Group Members (paginated) ─┐
       └─ no ───────────────────────────────────────────┤
                                                        ▼
                                    Query Users (paginated, execute once)
  → Build Signed Snapshot → Post Snapshot
```

| Node | Purpose |
|---|---|
| Every 2 Minutes | Schedule Trigger, every 2 minutes. |
| Sync Now Webhook | `POST /webhook/btc-scheduler/queue-sync-now`, raw body enabled, responds through a Respond to Webhook node. Called by the app's "Sync now" admin button (`requestSyncNow`). |
| Verify Sync Now Signature | Checks `X-BTC-Timestamp` (5-minute window) and `X-BTC-Signature` (`sha256=` HMAC of `"<timestamp>.<raw body>"`) with `$env.BTC_SCHEDULER_N8N_SIGNING_SECRET`, using a constant-time compare. Invalid requests get 401 and stop. Valid ones get 202 and continue with a normal poll. There is no nonce store here: a replayed request within 5 minutes only causes one extra poll. |
| Sign Linked Queues Request, Get Linked Queues | `GET {BTC_SCHEDULER_BASE_URL}/api/sync/linked-queues`, HMAC-signed over an empty body with `$env.BTC_SCHEDULER_SIGNING_SECRET`. Returns `{ "queueIds": [...] }` for teams whose membership source is not `manual`. |
| Has Linked Queues? | Stops when the list is empty. |
| Get SF Token | Execute Workflow on `SF Token Broker` (`7wen5ULQg7DBlCvC`), no inputs. Later nodes send `Authorization: Bearer {{ $('Get SF Token')... .json.access_token }}`. |
| Query Queue Members | `GET /services/data/v60.0/query?q=SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (...)`. Pagination follows `nextRecordsUrl` until `done` is true (100 pages maximum). |
| Collect Members | Splits members into users (`005...`) and nested groups (`00G...`), and builds the next two queries. |
| Query Nested Group Members | Runs only when a queue contains a public group. Reads that group's members. One level of nesting is expanded. Members that are themselves groups are skipped and counted in `skippedNested`. Roles, roles-and-subordinates and territories are not expanded. |
| Query Users | `SELECT Id, Email, IsActive FROM User WHERE Id IN (SELECT UserOrGroupId FROM GroupMember WHERE GroupId IN (<queues and nested groups>))`, paginated, executed once. |
| Build Signed Snapshot | Builds `{ snapshotId, takenAt, queues: [{ queueId, members: [{ sfUserId, email, isActive }] }] }`. Every linked queue is present, with `members: []` when it is empty, so the app can apply its empty-queue safety rail. Inactive users are sent with `isActive: false`; the app treats them as removed. Signs the exact body string and uses `snapshotId` as `X-BTC-Nonce`. |
| Post Snapshot | `POST {BTC_SCHEDULER_BASE_URL}/api/sync/queue-snapshot` with the signed raw body. A non-2xx response fails the node, so the workflow's error workflow runs. Not retried, because the nonce may only be used once; the next run 2 minutes later retries naturally. |

Why the extra user query: `GroupMember` has no `User` relationship in SOQL, so `SELECT User.Email, User.IsActive FROM GroupMember` is rejected by Salesforce ("Didn't understand relationship 'User'"). This was verified against the production org on 2026-10-02.

### Environment variables (n8n)

| Variable | Value |
|---|---|
| `BTC_SCHEDULER_BASE_URL` | App origin, for example `https://book.bigthinkcapital.com` (no trailing slash). |
| `BTC_SCHEDULER_SIGNING_SECRET` | Same value as the app's `SF_SYNC_SIGNING_SECRET`. Signs `linked-queues` and `queue-snapshot` requests. |
| `BTC_SCHEDULER_N8N_SIGNING_SECRET` | Same value as the app's `N8N_SIGNING_SECRET`. Verifies "Sync now" requests from the app. |
| `SF_INSTANCE_URL` | Optional. Defaults to `https://bigthink.my.salesforce.com`. |

The Code nodes use `require('crypto')`, which must be allowed (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`, already the case for the token broker's JWT signing).

### App endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/sync/linked-queues` | HMAC over empty body | |
| `POST /api/sync/queue-snapshot` | HMAC + `X-BTC-Nonce` (required, single use) | Body at most 2 MB. Returns `{ ok, snapshotId, teams: [{ teamId, status, reason?, counts?, events, reassignJobs, alertId? }], rejectedQueueIds }`. `status` is `applied`, `blocked` (safety rail), `skipped` or `error`. Returns 422 when none of the queues is linked, 409 on a reused nonce, 401 on a bad or stale signature, and 500 when any team failed (other teams are still applied). |

Responses contain counts only, never emails.

### Import and activate

1. In n8n, Workflows > Import from File, choose `n8n/sf-queue-snapshot-poller.json`.
2. Confirm `Get SF Token` points at `SF Token Broker` (`7wen5ULQg7DBlCvC`).
3. Settings: the error workflow is set to `Q3Ld5IrQCtGimErY` (the error workflow used by the token broker). Change it if a different one should be alerted. Successful executions are not saved, to avoid storing employee emails in execution history.
4. Set the environment variables above and restart n8n if they are read at start-up.
5. Run once manually and check that `Post Snapshot` returns `ok: true`. Then activate.

### Operations

- Staleness: the app's `/api/cron/queue-sync-health` cron (every 10 minutes) marks a queue-driven team `stale` and raises one `sync_stale` alert when no snapshot has arrived for `QUEUE_POLL_STALE_MINUTES` (default 10). The next applied snapshot resolves it.
- Safety rail: when a snapshot would pause more than the team's `mass_removal_threshold_pct` of its active queue members, or a linked queue that previously had members comes back empty, nothing is applied, the team's `sync_health` becomes `blocked`, and a `mass_removal_blocked` alert is raised (updated, not duplicated, on later polls). An admin can resolve the alert with "approve", which lets the next snapshot within 30 minutes apply once.
- Unlinking a queue does not change members immediately. The next snapshot pauses members who were only in that queue, subject to the safety rail.
