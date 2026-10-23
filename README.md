# BTC Scheduler

Big Think Capital's scheduling platform, replacing Calendly. Employees sign in with Microsoft 365, their Outlook calendars drive availability, and every booking is written to Outlook. Individual and team booking pages (round-robin and collective), English and Spanish variants, Salesforce Queue-driven team membership, Slack channel sync, and optional Salesforce Lead creation per booking page.

The approved design is in [`docs/PLAN.md`](docs/PLAN.md).

## Contents

- [Architecture](#architecture)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Microsoft Entra app registration](#microsoft-entra-app-registration)
- [Slack app](#slack-app)
- [Queue to booking page to Slack sync](#queue-to-booking-page-to-slack-sync)
- [Reminders and SMS](#reminders-and-sms)
- [Salesforce and n8n](#salesforce-and-n8n)
- [Deploying to Vercel](#deploying-to-vercel)
- [Cron jobs](#cron-jobs)
- [REST API and MCP server](#rest-api-and-mcp-server)
- [Importing from Calendly](#importing-from-calendly)
- [Adding an admin](#adding-an-admin)
- [Error log](#error-log)
- [Partner page branding](#partner-page-branding)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Future work](#future-work)

## Architecture

```
Browser ──> Next.js (Vercel) ──> Postgres (Supabase, schema "app", RLS on every table)
               │    ▲
               │    └── inbound, verified: Graph change notifications (clientState),
               │        queue snapshot / push (HMAC or bearer), n8n
               └──────> outbound via the jobs outbox: Microsoft Graph, Resend,
                        Slack Web API, n8n (Salesforce through the SF Token Broker)
```

| Concern | Approach |
|---|---|
| Sign-in | Entra ID OIDC, authorization code + PKCE, single tenant. Server-side sessions in `app.sessions`; the browser holds only an opaque httpOnly cookie. |
| Graph tokens | Encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEYS`), bound to the user id. Refreshed under a row lock. Revoked consent marks the connection `broken`, shows a "Reconnect Outlook" banner, and removes the user from round-robin until they reconnect. |
| Data access | `withUser()` runs queries as the `app_user` role with the user's id in `request.jwt.claims`, so RLS applies. Webhooks, cron and the public booking engine use the owner connection through a small set of server modules. |
| Availability | Busy blocks cached from Outlook (`app.busy_blocks`), kept current by Graph subscriptions plus delta queries every 15 minutes. A live `getSchedule` check runs just before each booking. |
| Double booking | A Postgres exclusion constraint on each host's booked time range (buffers included), plus an advisory lock and row locks while assigning within the booking transaction. |
| Background work | `app.jobs` outbox with retries, exponential backoff and per-attempt logs (`app.job_attempts`). A Vercel Cron route drains it every minute using `FOR UPDATE SKIP LOCKED`. |
| Salesforce | The app never calls Salesforce. It posts HMAC-signed requests to n8n, and n8n uses the existing SF Token Broker. A 2-minute n8n poller sends Queue membership snapshots back to the app. |
| i18n | `next-intl`. Locales are configured in `src/i18n/locales.ts`, with catalogs in `messages/`. |
| Branding | One theme file: `src/theme/brand.ts` (plus the matching CSS tokens in `src/app/globals.css`). |

## Local setup

Requirements: Node 22, pnpm 10, Postgres 16 with `btree_gist`, `citext` and `pgcrypto` (the Supabase CLI's local stack also works).

```bash
pnpm install
scripts/local-db.sh start            # Postgres 16 on 127.0.0.1:54329, prints DATABASE_URL
cp .env.example .env.local           # fill in values (see below)
pnpm db:migrate                      # applies supabase/migrations in order
pnpm seed                            # demo users, teams, event types, bookings
pnpm dev                             # http://localhost:3000
```

Sign-in needs a real Entra app registration (see below) with `http://localhost:3000/api/auth/callback` registered. Without one, the public booking pages still work against the seed data: try `/demo-mike/intro-call` and `/t/demo-sdr/funding-consultation`.

## Environment variables

Every variable is documented in [`.env.example`](.env.example). Summary:

| Variable | Required | Purpose |
|---|---|---|
| `APP_BASE_URL` | yes | Public base URL; used for OAuth redirects, Graph notification URLs and email links |
| `MCP_BASE_URL` | no | Public origin of the MCP server (for example `https://mcp.bigthinkcapital.com`); defaults to `APP_BASE_URL` |
| `DATABASE_URL` | yes | Postgres connection (Supabase transaction pooler, port 6543, in production) |
| `DATABASE_POOL_MAX` | no | Connections per instance (default 5) |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | yes | Entra app registration |
| `ALLOWED_EMAIL_DOMAINS` | no | Default `bigthinkcapital.com` |
| `ADMIN_EMAILS` | no | Emails promoted to admin at sign-in |
| `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_ACTIVE_KID` | yes | AES-256-GCM key ring for secrets at rest |
| `IP_HASH_SALT` | yes | Salt for hashed client IPs |
| `CRON_SECRET` | yes | Vercel Cron bearer secret |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | production | Cloudflare Turnstile on public forms |
| `RESEND_API_KEY`, `EMAIL_FROM` | production | Transactional email; without a key, emails are logged instead of sent |
| `SLACK_BOT_TOKEN`, `SLACK_ADMIN_NOTIFY_CHANNEL` | optional | Slack channel sync and agent reminder direct messages |
| `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET` | optional | SendBlue text reminders; without them, texts are logged instead of sent |
| `SENDBLUE_FROM_NUMBER` | optional | SendBlue sending line in E.164; required on shared-line plans |
| `SENDBLUE_WEBHOOK_SECRET` | with SMS | Secret SendBlue sends in `sb-signing-secret` to `/api/sms/inbound` (STOP / START replies) |
| `N8N_BASE_URL`, `N8N_LEAD_WEBHOOK_PATH`, `N8N_SIGNING_SECRET` | for SF | Outbound requests to n8n |
| `SF_SYNC_SIGNING_SECRET`, `SF_QUEUE_PUSH_BEARER` | for SF | Inbound queue snapshot and push authentication |
| `SF_LEAD_MAX_ATTEMPTS`, `QUEUE_POLL_STALE_MINUTES` | no | Tuning (defaults 8 and 10) |

Generate a 32-byte key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Microsoft Entra app registration

Step-by-step instructions: [`docs/entra-setup.md`](docs/entra-setup.md). In short: single-tenant Web app, redirect URI `<APP_BASE_URL>/api/auth/callback` for each environment, a client secret, delegated Graph permissions `openid profile email offline_access User.Read Calendars.ReadWrite OnlineMeetings.ReadWrite`, and tenant-wide admin consent (recommended).

## Slack app

Manifest: [`slack/manifest.yml`](slack/manifest.yml). Install steps, scopes and workspace settings: [`docs/slack-setup.md`](docs/slack-setup.md). New channel and user group links start in dry-run mode with mode `add only`, which never removes anyone; set the mode to `add and remove` for reps who leave the queue to be taken out. A Slack user group can be linked to one team only.

The manifest now includes `usergroups:read` and `usergroups:write` (for a team's linked Slack user group). An app installed before this change must be updated from the manifest and reinstalled before a user group link is turned live; channel sync keeps working without them. Without `SLACK_BOT_TOKEN`, Slack jobs succeed with a `slack_not_configured` result and change nothing.

## Queue to booking page to Slack sync

When a rep leaves a partner's Salesforce Queue, the next snapshot (or push) pauses their team membership, which takes them off every booking page of that team at once, including pages with their own host list. Their upcoming bookings follow the team's removal policy (`reassign` queues a reassignment; `keep_bookings` keeps them and lists them for review), and Slack jobs remove them from the partner's linked channels and user group. Adding a rep to the queue reverses it. Manual members are never changed by the sync, and teams without a linked queue or Slack link (such as the teams imported from Calendly) get no sync or Slack work. Status per team: **Admin > Sync status** (`/admin/sync`). Details: [`docs/queue-slack-sync.md`](docs/queue-slack-sync.md).

## Reminders and SMS

Each booking page sets its own reminders in the editor (**Reminders** section):

- Merchant (invitee) reminders by email and/or text message at the chosen times. Default: email at 1 day and 1 hour before, as before.
- Agent (host) reminders by email, Slack direct message and/or text message, at 5, 15, 30, 60 minutes or 1 day before. Default: off.

Team pages show the partner (team) name in merchant emails, texts, agent reminders and the Outlook event. Text messages go through SendBlue; merchants can reply STOP to opt out and START to opt back in. Setup, the webhook and the job keys: [`docs/reminders.md`](docs/reminders.md).

## Salesforce and n8n

- n8n workflows (lead creation, queue snapshot poller), with importable JSON in [`/n8n`](n8n): [`docs/n8n-workflows.md`](docs/n8n-workflows.md).
- Salesforce changes for BTC to apply (Named Credential, optional Flow HTTP Callout, `QueueManagementController` change): [`docs/salesforce-changes.md`](docs/salesforce-changes.md). Nothing is deployed to Salesforce by this repository.
- Lead creation is off by default and is enabled per booking page by an admin. "Lead source" is the ISO (`csbs__ISO__c`).
- **Admin > Lead routing (ISO)** (`/admin/salesforce/lead-routing`) lists every booking page with its lead toggle, ISO and lead owner mode, and links to each page's Salesforce settings.

## Deploying to Vercel

1. Create a Supabase project (BTC Org; production uses `us-west-2`). Functions run in the matching Vercel region, `pdx1`, set in `vercel.json`; keep the two together, because every request makes several database round trips. Under **Project > Connect**, copy the **Transaction pooler** connection string into `DATABASE_URL`.
2. Apply migrations: `DATABASE_URL=<pooler url> pnpm db:migrate` (or paste the files in `supabase/migrations/` into the SQL editor, in order).
3. Import the GitHub repository into Vercel (framework: Next.js). The Vercel team must be on **Pro** for per-minute cron jobs.
4. Set every environment variable for Production and Preview. Use a separate `APP_BASE_URL` and Entra redirect URI per environment; Preview needs a stable alias (see `docs/entra-setup.md`).
5. Production must not sit behind Vercel deployment protection, or at least `/api/graph/*`, `/api/sync/*` and the public booking pages must be excluded. Graph cannot validate a protected webhook URL.
6. Optional but recommended: add a Vercel Firewall rate-limit rule for `/api/public/*`.
7. Deploy, sign in as an admin, and check **Admin** for connection health.

### Employee sign-in

The public root (`/`) is a minimal branded landing page with a "Team sign in" link; it does not describe internal features. Employees sign in at `<APP_BASE_URL>/login` with their Big Think Capital Microsoft 365 account. The first sign-in creates their account automatically (any address in `ALLOWED_EMAIL_DOMAINS`) and connects their Outlook calendar. Grant tenant-wide admin consent for the Entra app so employees are not prompted for consent individually.

## Cron jobs

Defined in [`vercel.json`](vercel.json). Each route checks `Authorization: Bearer $CRON_SECRET`.

| Route | Schedule | Purpose |
|---|---|---|
| `/api/cron/jobs` | every minute | Drain the jobs outbox (Graph writes, email, Slack, Salesforce) |
| `/api/cron/graph-subscriptions` | every 6 hours | Renew Graph subscriptions expiring within 48 hours; create missing ones |
| `/api/cron/graph-delta` | every 15 minutes | Delta reconciliation for every healthy calendar connection |
| `/api/cron/reminders` | every 5 minutes | Safety net for reminders (email, SMS and Slack direct messages) |
| `/api/cron/queue-sync-health` | every 10 minutes | Flag teams whose queue snapshot is stale |
| `/api/cron/maintenance` | daily 04:17 UTC | Purge expired sessions, OAuth state, codes and tokens, nonces, rate-limit windows, old job rows, old error log entries and API request log entries older than 30 days |

## REST API and MCP server

AI assistants connect to the MCP server at `https://mcp.bigthinkcapital.com/mcp` (or `<APP_BASE_URL>/mcp`), signing in with Microsoft through OAuth 2.1. Scripts use the REST API at `<APP_BASE_URL>/api/v1` with an API key. Both act as the signed-in user with their role:

- **Agent:** their own bookings and pages.
- **Manager:** reads everything.
- **Admin:** manages everything.

Every change is audited with its channel. Each authenticated request is recorded in `app.api_request_log` (caller, key or app, route, JSON-RPC methods, status and duration; never bodies) for 30 days. Users manage their API keys and connected apps, and see their recent requests, under **Settings > Integrations**. Admins manage the allowed OAuth callback URLs and clients, and see all recent requests, under **Admin > Integrations**. For setup (including the mcp.bigthinkcapital.com domain), the tool list and the endpoints, see [`docs/api-and-mcp.md`](docs/api-and-mcp.md).

## Importing from Calendly

**Admin > Import** (`/admin/import`) copies the Calendly organization from a JSON snapshot built by `scripts/calendly-snapshot.py`. The runbook covers pulling the data, building the snapshot, the dry run, going live and keeping in sync: [`docs/calendly-import.md`](docs/calendly-import.md). In short:

- **Nothing changes in Calendly and nobody is notified.** Imported bookings never create outbox jobs (`jobs_skip_imported_bookings` trigger), and hosts cannot cancel them in the app.
- **Imported pages start inactive.** An admin takes them live per rep, per team or all at once on the same page. Until then, only admins can activate them (`event_types_guard_imported` trigger).
- **What is copied.** Members get their default Calendly schedule as working hours and are linked to their Microsoft account at first sign-in. Calendly team profiles become teams. Upcoming meetings hold the host's time, including buffers.
- **Re-runs are safe.** They apply Calendly cancellations, moves and reassignments. Older or apparently incomplete snapshots are refused.

## Adding an admin

Roles are global: `admin`, `manager` (reads everything, changes nothing that belongs to others) and `user` (shown as Agent). See `src/lib/permissions.ts` and [`docs/api-and-mcp.md`](docs/api-and-mcp.md#roles). To make someone an admin, any of these works:

- Add the email to `ADMIN_EMAILS` in Vercel. It applies at that person's next sign-in.
- Insert into the seed table (applies at next sign-in): `insert into app.admin_seeds (email) values ('name@bigthinkcapital.com');`
- An existing admin uses **Admin > Users** to change the role (audited).

Team admins (manage one team's members and settings, but not Salesforce, Slack or queue links) are assigned on the team page.

## Error log

Server errors from pages, route handlers, server actions, cron routes, the REST API, the MCP server and failed jobs are recorded in `app.error_log` and listed at **Admin > Errors** (`/admin/errors`, admins only). Repeats of the same error are grouped and counted. Messages, stacks and context are redacted before they are stored (tokens, cookies, email addresses, phone numbers and long digit runs). Admins resolve or reopen entries; both actions are audited. Resolved entries are purged after 90 days and all entries after 180 days.

Request errors are captured by the `onRequestError` hook in `src/instrumentation.ts`. Other modules record errors they handle with `logError(err, { source, route, method, context })` from `src/server/errors/log.ts`, which never throws. No environment variables are needed. Details: [`docs/error-log.md`](docs/error-log.md).

## Partner page branding

Admins and a team's team admins can customize the team's public pages at **Teams > {team} > Branding** (`/teams/{id}/branding`): display name, logo (PNG, JPEG or WebP up to 512 KB; no SVG), accent color (falls back to BTC blue below 4.5:1 contrast with white), heading, intro, and whether to show the partner logo, BTC logo, host photo, host name, meeting length and description. Logos are served from `/api/public/team-logo/{teamId}`. Changes are audited. No new environment variables. Details: [`docs/partner-branding.md`](docs/partner-branding.md).

## Testing

```bash
scripts/local-db.sh start
pnpm test:unit          # pure logic: slots, DST, round-robin, variants, crypto, payloads
pnpm test:integration   # real Postgres: RLS, booking races, sync, Slack, Salesforce outbox, Graph (mocked)
pnpm test:e2e           # Playwright booking flow (Chromium)
pnpm test:e2e:internal  # internal UI smoke tests against a running app (see docs/internal-ui.md)
pnpm typecheck && pnpm lint
```

Integration tests rebuild the `btc_scheduler_test` database from the migrations on every run. Set `TEST_DATABASE_URL` to use another database.

### Notes for contributors

- `app_user` has column-level SELECT on `app.bookings` (the encrypted manage token is excluded), so code running under `withUser()` must list columns explicitly; `select *` on `app.bookings` fails.
- Reserved first path segments (`t`, `b`, `api`, `login`, `dashboard`, ...) cannot be used as user slugs.
- The e2e suite seeds `btc_e2e_booking` and starts the app on port 3417 (`E2E_PORT` overrides).
- The internal UI e2e suite needs a running app and a database from `scripts/e2e-internal-db.sh` (seed: `tests/e2e/internal-seed.sql`).
- Admin and roster server actions delegate to `src/server/{sync,slack,salesforce}/admin.ts`, which authorize and audit; see `docs/internal-ui.md`.

## Project layout

```
src/app/(public)        public booking pages (/{user}, /{user}/{event}, /t/{team}/{event}, /b/{token})
src/app/(app)           employee and admin UI
src/app/api             auth, Graph webhooks, sync endpoints, public API, cron
src/server/auth         Entra OIDC, sessions, first-login provisioning
src/server/graph        Graph client, busy cache, subscriptions, delta, event writes
src/server/scheduling   pure slot engine, round-robin, variant resolution
src/server/booking      booking transaction, manage links, reassignment
src/server/sync         Salesforce Queue snapshot diffing, safety rail, run history and sync status
src/server/slack        Slack channel and user group sync, agent reminder direct messages
src/server/sms          SendBlue client, SMS reminders, opt-outs
src/server/teams        partner page branding and logos
src/server/salesforce   Lead payload mapping and outbox handler
src/server/email        Resend sending and templates
src/server/jobs         outbox, worker, job contracts
src/server/errors       error log: redaction, fingerprinting, logError(), admin queries
supabase/migrations     schema and RLS
n8n/                    importable n8n workflows
docs/                   plan, setup guides, runbook
```

## Future work

Not in v1: payments, Google Calendar, routing forms and pre-booking qualification, languages beyond English and Spanish (adding one is configuration plus a message catalog).
