# Internal UI (employee and admin)

English-only pages under `src/app/(app)` plus the sign-in page. Server components by default; mutations are server actions validated with Zod.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `/login` | public | Microsoft sign-in, `?error=` codes, `?signedOut=1` notice |
| `/` | public | Redirects to `/dashboard` or `/login` |
| `/dashboard` | user | Next 7 days, calendar status (reconnect or disconnect Outlook), booking link, teams |
| `/bookings`, `/bookings/[id]` | user (RLS) | Upcoming/past, filters, detail, host cancel |
| `/event-types`, `/new`, `/[id]`, `/[id]/variants` | owner or team admin | Editor, questions, host pool, public links (English and `/es`), Spanish variants and inheritance |
| `/availability` | user | Weekly hours, date overrides, booking preferences |
| `/teams`, `/teams/[id]` | user; roster for team admins | Members (add, pause, unpause, remove manual members), settings, team admins (admins), distribution, membership log |
| `/admin/**` | admin | Overview, new team, queue sync, Slack channels, Salesforce settings and jobs, users, audit log |

Authorization is checked on the server in every page and action (`requireUser` / `requireAdmin`, then RLS through `withUser`). Hidden UI is never the control.

## Patterns

- **Forms:** `ActionForm` (`src/components/ui/Form.tsx`) wraps `useActionState`. Actions return `ActionState` (`src/lib/form-state.ts`); field errors are keyed by field name and read by `Input`, `Select`, `Textarea`, `Checkbox`, `Switch`. Success messages go to the layout toast region so they survive revalidation.
- **Admin and roster actions delegate to the back-end modules.** `src/app/(app)/admin/_actions/{sync,slack,salesforce}.ts` and the roster actions in `src/app/(app)/teams/_actions.ts` parse the form with Zod and call `src/server/sync/admin.ts`, `src/server/slack/admin.ts` or `src/server/salesforce/admin.ts`. Those functions authorize (RLS plus an admin or team-admin check) and write the audit entry in the same transaction as the change, so actions never write audit rows themselves. Calls are wrapped in `audited()` (`src/server/ui/admin.ts`), which attaches the request's ip hash to every audit entry through `withAuditContext()` (`src/server/audit.ts`). `adminError()` turns the modules' errors (`SyncAdminError`, `SlackAdminError`, `ForbiddenError`, `NotFoundError`, `SfSettingsValidationError`, `SlackNotConfiguredError`) into form errors.
- **Jobs from user actions:** `app_user` cannot insert into `app.jobs`. Roster changes enqueue their Slack job and any booking reassignment through security-definer functions (`app.enqueue_membership_slack_sync`, `app.enqueue_member_reassignments`) inside the same transaction; they check that the caller is a team admin and wrote the membership event. Slack resyncs use the service connection after an admin check (`fullResync`).
- **Host cancel:** `src/server/booking/host-actions.ts`. Status change under RLS, then `booking_hosts.active = false` and the `graph_event_delete` / `email_send` jobs with the service connection. Safe to repeat.
- **Insert without RETURNING:** the SELECT policies on `event_types` and `availability_schedules` call security-definer functions that cannot see a row inserted by the same statement, so `INSERT ... RETURNING` fails under RLS. Generate the id with `randomUUID()` instead (covered by `tests/integration/host-actions.test.ts`).
- **Cross-user reads for team admins:** Outlook connection status of team members and team member counts are read with the service connection after the team-admin check, selecting only the status or aggregate columns.
- **Variants:** pages import `resolveVariant` from `src/server/scheduling/resolve.ts`. Toggling a group adds or removes it from `child.overrides` and copies the parent's values when a group becomes overridden. `sf_settings` is admin-only; inheriting again deletes the variant's own Salesforce row.

## Roster changes

All membership changes from the UI go through `src/server/sync/admin.ts`, which writes a `membership_events` row and enqueues `slack_membership_sync` for it in the same transaction:

| Change | Function | Who | Notes |
|---|---|---|---|
| Pause, unpause | `manualMemberOverride(actor, memberId, status, note, { teamId, checkOnboarding: true })` | team admins, admins | Pause sets `paused_reason = 'admin_override'`, which sync never reinstates. Unpause sets `active`, or `pending_onboarding` without a signed-in user and healthy Outlook connection. When the team's `removal_policy` is `reassign`, a pause enqueues `booking_reassign` for the member's future confirmed bookings on that team (as primary host), like a queue removal. |
| Add manual member | `addManualMember(actor, teamId, email)` | team admins, admins | Company domains only. Not allowed on `salesforce_queue` teams. |
| Remove manual member | `removeManualMember(actor, memberId, { teamId })` | team admins, admins | Manual members only, and only without upcoming bookings on the team; queue members can only be paused. The event and Slack job are written before the row is deleted. |
| Create team | `createTeam(actor, input)` | admins | `/admin/teams/new`. |

## Admin overview

`/admin` counts come from `loadAdminCounts()` (`src/server/ui/overview.ts`): open `sync_alerts` (`resolved_at is null`), dead `sf_lead_create` jobs (`sf_lead_jobs.status = 'dead'`, with failed jobs in the hint), `team_slack_channels` whose `health` is not `ok`, and active users whose `calendar_connections.status` is `broken`.

## Outlook disconnect

The dashboard calendar card has **Disconnect Outlook** (with confirmation). `disconnectCalendar()` (`src/server/graph/disconnect.ts`) deletes the Graph subscription (best effort), sets the connection to `disconnected`, clears the access and refresh tokens, the delta link and the subscription fields, and writes a `calendar.disconnect` audit entry. Signing in again with "Reconnect Outlook" restores it.

## Slack preview and health

The Slack page's preview (`?preview=<config id>`) calls `previewChannel()`, which reads the channel's real members from Slack; nothing is changed. **Check health** calls `checkChannelHealth()` (`conversations.info`). Both need `SLACK_BOT_TOKEN`; without it the page shows "Slack is not configured" instead of the preview.

## React Bits

`src/components/reactbits/` holds adaptations of React Bits Pro items, credited in each file: `silk-waves-tw` (raw WebGL port, sign-in background, lazy loaded), `3d-letter-swap-tw` (CSS keyframes, sign-in headline) and the `stats-4` block (stat cards with a count-up). All respect `prefers-reduced-motion` and add no dependencies.

## End-to-end smoke tests

`tests/e2e/internal.spec.ts` runs against a running app and a disposable database seeded with `tests/e2e/internal-seed.sql`. The seed holds three sessions: `user-smoke-token` (Ana Lopez, a regular user who is team admin of Funding Advisors), `admin-smoke-token` (Mike Perticone, global admin) and `broken-smoke-token` (Bob Smith, broken Outlook connection). `sessions.id` is the SHA-256 hex of the raw token; the dev cookie is `btc_session`.

```bash
scripts/e2e-internal-db.sh                     # recreates btc_e2e_internal, prints its DATABASE_URL
# The session cookie is btc_session only outside production (production uses __Host-, which needs https).
APP_BASE_URL=http://localhost:3100 DATABASE_URL=postgres://postgres@127.0.0.1:54329/btc_e2e_internal \
  ENTRA_TENANT_ID=00000000-0000-4000-8000-000000000001 ENTRA_CLIENT_ID=00000000-0000-4000-8000-000000000002 \
  ENTRA_CLIENT_SECRET=test TOKEN_ENCRYPTION_KEYS="k1:$(node -e 'console.log(Buffer.alloc(32,7).toString("base64"))')" \
  TOKEN_ENCRYPTION_ACTIVE_KID=k1 IP_HASH_SALT=e2e-ip-hash-salt-000000 CRON_SECRET=e2e-cron-secret-000000 \
  pnpm dev -p 3100 &
E2E_USER_TOKEN=user-smoke-token E2E_ADMIN_TOKEN=admin-smoke-token E2E_SHOT_DIR=/tmp/shots \
  CHROMIUM_PATH=/path/to/chrome pnpm test:e2e:internal
```

The interaction tests change data (they remove a member, approve an alert, create a team and disconnect the admin's Outlook), so recreate the database before each run. Slack, n8n and Graph are not configured in this setup; the tests accept the "not configured" messages for the Slack preview, health check and Sync now.
