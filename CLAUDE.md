@AGENTS.md

# BTC Scheduler: conventions

Read `docs/PLAN.md` first. It is the approved design.

## Stack
- Next.js 16 App Router (async `cookies()`, `headers()`, `params`; `proxy.ts` replaces middleware). Read `node_modules/next/dist/docs/` before using an unfamiliar API.
- Postgres via `postgres` (porsager) in `src/server/db/client.ts`. No ORM. All tables are in the `app` schema; always write `app.table_name`.
- Luxon for all time math. Store UTC `timestamptz`. Never use the `Date` local-time getters for business logic.
- Zod for every external input. Tailwind v4 with brand tokens from `src/app/globals.css` and `src/theme/brand.ts`.
- next-intl for public pages and invitee emails. Catalogs in `messages/{en,es}.json`. Internal (employee/admin) UI is English only.

## Data access rules
- Requests for a signed-in employee: `withUser(user.id, (tx) => ...)`. RLS applies.
- Webhooks, cron, public booking engine, sign-in: `service()` / `serviceTx()`. These bypass RLS, so validate everything and select only the columns you need.
- Public pages must never expose Salesforce IDs, emails of non-assigned members, weights, tiers, or internal flags.
- Admin changes must call `writeAudit()` in the same transaction.
- Side effects (Graph, Slack, n8n, email) go through the `app.jobs` outbox: `enqueue()` inside the transaction, handler in `src/server/<module>/jobs.ts` (registered in `src/server/jobs/registry.ts`).
- Never log tokens, secrets, or full request bodies that contain them.

## Migrations
- New SQL files in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`, applied in order. Never edit a migration that has been applied to Supabase; add a new one.
- Every new table: `alter table ... enable row level security` plus app_user grants and policies.

## Tests
- `scripts/local-db.sh start` starts Postgres 16 on port 54329.
- `pnpm test:unit` (pure logic) and `pnpm test:integration` (recreates `btc_scheduler_test` from migrations).
- Integration helpers: `tests/helpers/db.ts` (`connectTestDb`, `truncateAll`, `makeUser`). Mock outbound HTTP with an injected `fetch` or MSW.
- `pnpm typecheck` and `pnpm lint` must pass.

## Writing
- Code comments and docs: plain, professional, concise.
