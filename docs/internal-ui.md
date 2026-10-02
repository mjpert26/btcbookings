# Internal UI (employee and admin)

English-only pages under `src/app/(app)` plus the sign-in page. Server components by default; mutations are server actions validated with Zod.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `/login` | public | Microsoft sign-in, `?error=` codes, `?signedOut=1` notice |
| `/` | public | Redirects to `/dashboard` or `/login` |
| `/dashboard` | user | Next 7 days, calendar status, booking link, teams |
| `/bookings`, `/bookings/[id]` | user (RLS) | Upcoming/past, filters, detail, host cancel |
| `/event-types`, `/new`, `/[id]`, `/[id]/variants` | owner or team admin | Editor, questions, host pool, Spanish variants and inheritance |
| `/availability` | user | Weekly hours, date overrides, booking preferences |
| `/teams`, `/teams/[id]` | user; roster for team admins | Members, pause, settings, team admins (admins), distribution, membership log |
| `/admin/**` | admin | Overview, queue sync, Slack channels, Salesforce settings and jobs, users, audit log |

Authorization is checked on the server in every page and action (`requireUser` / `requireAdmin`, then RLS through `withUser`). Hidden UI is never the control.

## Patterns

- **Forms:** `ActionForm` (`src/components/ui/Form.tsx`) wraps `useActionState`. Actions return `ActionState` (`src/lib/form-state.ts`); field errors are keyed by field name and read by `Input`, `Select`, `Textarea`, `Checkbox`, `Switch`. Success messages go to the layout toast region so they survive revalidation.
- **Jobs from user actions:** `app_user` cannot insert into `app.jobs`. Actions commit the change with `withUser`, then call `enqueueAfterCommit()` (`src/server/ui/jobs.ts`) with idempotency keys derived from the committed change.
- **Host cancel:** `src/server/booking/host-actions.ts`. Status change under RLS, then `booking_hosts.active = false` and the `graph_event_delete` / `email_send` jobs with the service connection. Safe to repeat.
- **Insert without RETURNING:** the SELECT policies on `event_types` and `availability_schedules` call security-definer functions that cannot see a row inserted by the same statement, so `INSERT ... RETURNING` fails under RLS. Generate the id with `randomUUID()` instead (covered by `tests/integration/host-actions.test.ts`).
- **Cross-user reads for team admins:** Outlook connection status of team members and team member counts are read with the service connection after the team-admin check, selecting only the status or aggregate columns.
- **Variants:** pages import `resolveVariant` from `src/server/scheduling/resolve.ts`. Toggling a group adds or removes it from `child.overrides` and copies the parent's values when a group becomes overridden. `sf_settings` is admin-only; inheriting again deletes the variant's own Salesforce row.

## Admin actions to rewire after merge

`src/app/(app)/admin/_actions/{sync,slack,salesforce}.ts` contain thin database implementations so this branch works alone. The TODO at the top of each file names the back-end function (`src/server/sync/admin.ts`, `src/server/slack/admin.ts`, `src/server/salesforce/admin.ts`) it should delegate to. `checkHealthAction` and the Slack preview need the Slack module for live data.

## React Bits

`src/components/reactbits/` holds adaptations of React Bits Pro items, credited in each file: `silk-waves-tw` (raw WebGL port, sign-in background, lazy loaded), `3d-letter-swap-tw` (CSS keyframes, sign-in headline) and the `stats-4` block (stat cards with a count-up). All respect `prefers-reduced-motion` and add no dependencies.

## End-to-end smoke tests

`tests/e2e/internal.spec.ts` runs against a running app and a disposable database that contains two sessions (a regular user who is a team admin, and an admin):

```bash
E2E_USER_TOKEN=<raw token> E2E_ADMIN_TOKEN=<raw token> E2E_SHOT_DIR=/tmp/shots \
CHROMIUM_PATH=/path/to/chrome pnpm test:e2e
```

`sessions.id` is the SHA-256 hex of the raw token; the dev cookie is `btc_session`. The interaction tests change data.
