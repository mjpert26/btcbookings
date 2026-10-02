# BTC Scheduler

Big Think Capital's scheduling platform, replacing Calendly. Employees sign in with Microsoft 365, their Outlook calendars drive availability, and every booking is written to Outlook. Individual and team booking pages (round-robin and collective), English and Spanish variants, Salesforce Queue-driven team membership, Slack channel sync, and optional Salesforce Lead creation per booking page.

The approved design is in [`docs/PLAN.md`](docs/PLAN.md).

## Contents

- [Architecture](#architecture)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Microsoft Entra app registration](#microsoft-entra-app-registration)
- [Slack app](#slack-app)
- [Salesforce and n8n](#salesforce-and-n8n)
- [Deploying to Vercel](#deploying-to-vercel)
- [Cron jobs](#cron-jobs)
- [Adding an admin](#adding-an-admin)
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
| `SLACK_BOT_TOKEN`, `SLACK_ADMIN_NOTIFY_CHANNEL` | optional | Slack channel sync |
| `N8N_BASE_URL`, `N8N_LEAD_WEBHOOK_PATH`, `N8N_SIGNING_SECRET` | for SF | Outbound requests to n8n |
| `SF_SYNC_SIGNING_SECRET`, `SF_QUEUE_PUSH_BEARER` | for SF | Inbound queue snapshot and push authentication |
| `SF_LEAD_MAX_ATTEMPTS`, `QUEUE_POLL_STALE_MINUTES` | no | Tuning (defaults 8 and 10) |

Generate a 32-byte key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Microsoft Entra app registration

Step-by-step instructions: [`docs/entra-setup.md`](docs/entra-setup.md). In short: single-tenant Web app, redirect URI `<APP_BASE_URL>/api/auth/callback` for each environment, a client secret, delegated Graph permissions `openid profile email offline_access User.Read Calendars.ReadWrite OnlineMeetings.ReadWrite`, and tenant-wide admin consent (recommended).

## Slack app

Manifest: [`slack/manifest.yml`](slack/manifest.yml). Install steps, scopes and workspace settings: [`docs/slack-setup.md`](docs/slack-setup.md). New channel configurations start in dry-run mode.

## Salesforce and n8n

- n8n workflows (lead creation, queue snapshot poller), with importable JSON in [`/n8n`](n8n): [`docs/n8n-workflows.md`](docs/n8n-workflows.md).
- Salesforce changes for BTC to apply (Named Credential, optional Flow HTTP Callout, `QueueManagementController` change): [`docs/salesforce-changes.md`](docs/salesforce-changes.md). Nothing is deployed to Salesforce by this repository.
- Lead creation is off by default and is enabled per booking page by an admin. "Lead source" is the ISO (`csbs__ISO__c`).

## Deploying to Vercel

1. Create a Supabase project (BTC Org, `us-east-1`). Under **Project > Connect**, copy the **Transaction pooler** connection string into `DATABASE_URL`.
2. Apply migrations: `DATABASE_URL=<pooler url> pnpm db:migrate` (or paste the files in `supabase/migrations/` into the SQL editor, in order).
3. Import the GitHub repository into Vercel (framework: Next.js). The Vercel team must be on **Pro** for per-minute cron jobs.
4. Set every environment variable for Production and Preview. Use a separate `APP_BASE_URL` and Entra redirect URI per environment; Preview needs a stable alias (see `docs/entra-setup.md`).
5. Production must not sit behind Vercel deployment protection, or at least `/api/graph/*`, `/api/sync/*` and the public booking pages must be excluded. Graph cannot validate a protected webhook URL.
6. Optional but recommended: add a Vercel Firewall rate-limit rule for `/api/public/*`.
7. Deploy, sign in as an admin, and check **Admin** for connection health.

## Cron jobs

Defined in [`vercel.json`](vercel.json). Each route checks `Authorization: Bearer $CRON_SECRET`.

| Route | Schedule | Purpose |
|---|---|---|
| `/api/cron/jobs` | every minute | Drain the jobs outbox (Graph writes, email, Slack, Salesforce) |
| `/api/cron/graph-subscriptions` | every 6 hours | Renew Graph subscriptions expiring within 48 hours; create missing ones |
| `/api/cron/graph-delta` | every 15 minutes | Delta reconciliation for every healthy calendar connection |
| `/api/cron/reminders` | every 5 minutes | Safety net for reminder emails |
| `/api/cron/queue-sync-health` | every 10 minutes | Flag teams whose queue snapshot is stale |
| `/api/cron/maintenance` | daily 04:17 UTC | Purge expired sessions, OAuth state, nonces, rate-limit windows and old job rows |

## Adding an admin

Admins are global (`users.role = 'admin'`). Any of these works:

- Add the email to `ADMIN_EMAILS` in Vercel. It applies at that person's next sign-in.
- Insert into the seed table (applies at next sign-in): `insert into app.admin_seeds (email) values ('name@bigthinkcapital.com');`
- An existing admin uses **Admin > Users** to change the role (audited).

Team admins (manage one team's members and settings, but not Salesforce, Slack or queue links) are assigned on the team page.

## Testing

```bash
scripts/local-db.sh start
pnpm test:unit          # pure logic: slots, DST, round-robin, variants, crypto, payloads
pnpm test:integration   # real Postgres: RLS, booking races, sync, Slack, Salesforce outbox, Graph (mocked)
pnpm test:e2e           # Playwright booking flow (Chromium)
pnpm typecheck && pnpm lint
```

Integration tests rebuild the `btc_scheduler_test` database from the migrations on every run. Set `TEST_DATABASE_URL` to use another database.

## Project layout

```
src/app/(public)        public booking pages (/{user}, /{user}/{event}, /t/{team}/{event}, /b/{token})
src/app/(app)           employee and admin UI
src/app/api             auth, Graph webhooks, sync endpoints, public API, cron
src/server/auth         Entra OIDC, sessions, first-login provisioning
src/server/graph        Graph client, busy cache, subscriptions, delta, event writes
src/server/scheduling   pure slot engine, round-robin, variant resolution
src/server/booking      booking transaction, manage links, reassignment
src/server/sync         Salesforce Queue snapshot diffing and safety rail
src/server/slack        Slack channel sync
src/server/salesforce   Lead payload mapping and outbox handler
src/server/email        Resend sending and templates
src/server/jobs         outbox, worker, job contracts
supabase/migrations     schema and RLS
n8n/                    importable n8n workflows
docs/                   plan, setup guides, runbook
```

## Future work

Not in v1: payments, Google Calendar, SMS reminders (possibly via SendBlue), routing forms and pre-booking qualification, languages beyond English and Spanish (adding one is configuration plus a message catalog).
