# Audit log

`app.audit_log` is an append-only record of settings changes and booking activity (BTCSCHED-46, 47, 48). Entries are written with `writeAudit()` or `writeAuditDiff()` (`src/server/audit.ts`) in the same transaction as the change, so an entry exists exactly when the change committed. `app_user` can insert and select entries but never update or delete them.

Each entry has:

| Column | Meaning |
|---|---|
| `created_at` | When the change committed |
| `actor_user_id` | The signed-in user who made the change; null for invitees and the system |
| `action` | What happened, for example `event_type.update` or `booking.cancel` |
| `entity_type`, `entity_id` | What changed |
| `before`, `after` | Only the fields that changed, with their old and new values |
| `via` | The channel: `web`, `api`, `mcp`, `sync`, `system` (jobs and webhooks) or `public` (an invitee on the public booking pages) |
| `ip_hash` | Salted hash of the client IP for web changes; raw IPs are never stored |

## Settings changes (BTCSCHED-46)

Settings changes record only the fields that changed. `writeAuditDiff()` compares a before and an after snapshot with `changedFields()` and writes nothing when nothing changed.

| Area | Action | Entity | Fields |
|---|---|---|---|
| Event type editor | `event_type.update` | `event_type` | Name, slug, description, branding, durations, location, schedule, buffers, notice, limits, round-robin settings, active and listed flags, inheritance overrides, booking questions (keyed by question key) and team hosts (keyed by member email) |
| Event type reminders | `event_type.update_reminders` | `event_type` | Merchant and agent reminder offsets and channels |
| Weekly hours | `availability.weekly_update` | `availability_schedule` | Time zone and weekly rules |
| Date overrides | `availability.override_set`, `availability.override_remove` | `availability_schedule` | The date and its intervals |
| Booking preferences | `user_settings.update` | `user_settings` | Outlook statuses that block time, daily cap, conflict policy, host email notices, SMS number (masked) |
| Team settings | `team.settings_update` | `team` | Outlook conflict policy, removal policy, mass-removal threshold |
| Team member settings | `team.member_update` | `team_member` | Weight, priority tier, daily cap |
| Queue sync settings | `team.sync_settings.update` | `team` | Roster source, removal policy, mass-removal threshold |
| Salesforce settings | `sf_settings.update`, `sf_settings.toggle` | `event_type_sf_settings` | Each lead setting, inheritance and provenance |
| Slack channel | `slack_channel.updated` (and created, removed, dry run) | `team_slack_channel` | Mode, protected users, notice channel |
| Partner branding | `team.page_settings_update`, `team.logo_*` | `team` | Page settings; logo metadata |
| Users and roles | `user.role_change`, `user.promote_admin`, `user.demote_admin`, `user.update`, `user.deactivate` | `user` | Role, name, active state |

Existing event-style entries (team admins added or removed, queues linked, API keys, OAuth clients, callback URLs, imports) are unchanged.

**Secrets.** Tokens, keys and secrets are never passed to the audit log. As a safety net, `writeAudit()` replaces the values of secret-looking keys (`secret`, `password`, `access_token`, `refresh_token`, `manage_token`, `token_hash`, `token_enc` and similar) with `[redacted]`. Only scalar and array values are redacted: when such a key holds an object, the object is searched instead, and keys containing `@` or whitespace are never treated as secret names. This keeps maps keyed by data (team hosts by member email, booking questions by question key, overrides by date) readable, for example a host `signing.desk@...` or a question `signing_authority`. Phone numbers are stored only masked to the last four digits (`maskPhone()`, for example `***-4567`).

## Booking history (BTCSCHED-47)

Every booking lifecycle event writes exactly one `booking.*` entry with `entity_type = 'booking'`, in the same transaction as the change, whichever path made it. The helper is `writeBookingAudit()` in `src/server/booking/audit.ts`.

| Action | Paths | Actor and channel |
|---|---|---|
| `booking.create` | Public booking page; REST `POST /bookings`; MCP `schedule_meeting` | Invitee: actor null, `public`. REST/MCP: the caller, `api` or `mcp` |
| `booking.reschedule` | Invitee manage link; REST `POST /bookings/{id}/reschedule`; MCP `reschedule_booking` | As above. Recorded on the booking that moved; `after.newBookingId` names the new booking |
| `booking.cancel` | Invitee manage link (`public`); host cancel in the app (`web`), REST or MCP (`api`, `mcp`); Outlook conflict auto-cancel (`system`) | Host: the user. Invitee and system: actor null |
| `booking.reassign` | `booking_reassign` job (queue removal or manual pause on a team with removal policy "reassign") | Actor null, `system` |
| `booking.flag` | Outlook conflict with the "flag" policy; a reassignment that finds nobody free | Actor null, `system` |

Entries hold statuses, times, host names and user ids, reasons and the source (`outlook_conflict`, `reassign`). They never hold manage tokens, invitee contact details or answers. Bookings copied by the Calendly import get no per-booking entries; the import run writes `import.calendly.*` entries.

The REST and MCP booking services no longer write their own booking entries; the engine (`src/server/booking/{create,manage,host-actions,jobs}.ts` and `src/server/graph/delta.ts`) does, so each event is recorded once.

### Who can read a booking's history

Row-level security on `app.audit_log` (migrations `20261023080000_audit_history.sql` and `20261023080100_audit_history_reschedule_lookup.sql`):

- `audit_log_select`: managers and admins read every entry.
- `audit_log_booking_select`: everyone reads the entries of bookings they can read (`app.can_read_booking`), plus the `booking.reschedule` entry of the booking that a booking they can read replaced, so a new booking's timeline shows where it came from. The new booking must be named in `after.newBookingId` and must record the entry's booking as its `rescheduled_from_id`. Entity ids are cast with `app.try_uuid()`, which returns null for malformed values instead of failing.

Agents therefore see the history of bookings in their name only (bookings they host, pages they own, and teams they are team admin of), the same rule that decides which bookings they see. A host removed by a reassignment loses the booking and its history, and the new host gains both. When a reassignment finds no free host, the original host is restored (`active = true`, `reassigned_at = null`) and keeps the booking and its `booking.flag` entry.

`loadBookingHistory()` first reads the booking under row-level security (no booking, no history), then selects the booking's own entries and the reschedule entry of `rescheduled_from_id` by `entity_id`. It uses only leakproof equality conditions, so Postgres can use `audit_log_entity_idx` before it applies the policies. A condition on the `after` jsonb is not leakproof and would make Postgres check the policy on every reschedule entry in the log first.

The host booking detail page (`/bookings/{id}`) shows a **History** timeline: time, action, who (the user's name, "Invitee" or "System"), channel and the changed fields. REST `GET /api/v1/bookings/{id}` and MCP `get_booking` return the same history (`history[]` with `at`, `action`, `actor`, `actorLabel`, `via`, `changes`), read under the caller's row-level security.

## Audit viewer (BTCSCHED-48)

`/admin/audit` is open to admins and managers (capability `audit.read`). Managers see only the **Audit log** item in the admin navigation and cannot open other admin pages: `src/app/(app)/admin/layout.tsx` requires `audit.read`, and every other admin page sits in the `(admin-only)` route group, whose layout requires a global admin. Nothing on the page changes data.

Filters (query string; invalid values are ignored):

| Parameter | Filter |
|---|---|
| `actor` | User id of the actor |
| `entityType` | Exact entity type |
| `entityId` | Exact entity id |
| `action` | Prefix match, for example `booking.` or `event_type.update` |
| `via` | Channel |
| `from`, `to` | Whole days in the viewer's time zone |
| `cursor` | Keyset cursor for the next (older) page |

Pages hold 50 entries, newest first, ordered by `(created_at, id)`. Each row shows a readable field-level diff (old value struck through, new value). The data loader is `loadAuditPage()` in `src/server/audit-log.ts`; it reads under row-level security. The REST `GET /api/v1/audit` and MCP `list_audit_log` endpoints return the same entries with a `changes` diff.

## Code

```
src/server/audit.ts           writeAudit, writeAuditDiff, changedFields, redactSecrets, maskPhone, withAuditContext
src/server/booking/audit.ts   writeBookingAudit, hostNames
src/server/audit-log.ts       loadBookingHistory, loadAuditPage
src/lib/audit-diff.ts         fieldChanges, labels and value formatting (shared by the viewer, the timeline and the API)
src/components/app/AuditChanges.tsx  field-level diff component
```

Tests: `tests/integration/audit-history.test.ts` (one entry per lifecycle path, RLS, viewer filters and pagination), `tests/integration/audit-settings.test.ts` (field diffs), `tests/unit/audit-diff.test.ts`.
