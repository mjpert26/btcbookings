# Calendly import runbook

How to copy the Big Think Capital Calendly organization into BTC Scheduler without changing Calendly or notifying anyone. The import code is in `src/server/import/calendly/`. The admin screen is **Admin > Import** (`/admin/import`).

## Guarantees

- **Calendly is only read.** Pull the data with read-only calls: list members, event types, availability schedules, scheduled events and invitees.
- **Nobody is notified.** Imported bookings never create outbox jobs: the `jobs_skip_imported_bookings` trigger drops them. So there are no Outlook writes, emails, Slack messages or Salesforce leads, and hosts cannot cancel imported bookings in the app.
- **Nothing is bookable until an admin releases it.** Imported pages are created inactive. Only the cutover on Admin > Import, or another admin, can activate a page that has not been released (`event_types_guard_imported` trigger).
- **Re-runs are safe.** They add what is missing and leave admin edits alone. They apply Calendly cancellations, moves and reassignments to imported bookings. Older snapshots, and snapshots that look incomplete, are refused.

## 1. Pull the data

Use the Calendly API, or the MCP Host Calendly tools, with an account that can read the whole organization. **Emails and phone numbers must not be redacted.** Members are linked to their Microsoft sign-in by email, and bookings need invitee emails.

| File | Source | Notes |
|---|---|---|
| `members.json` | `GET /organization_memberships?organization=…` (all pages) | Flatten to `{uri, name, email, slug, timezone}` from each membership's `user`. |
| `event_types.json` | `GET /event_types?organization=…` (all pages, active and inactive) | For team types (`pooling_type` set), add `round_robin_hosts: {status, hosts: [{user}]}`. `status` is `complete` only when the full host list was read. |
| `availability/<user-id>.json` | `GET /user_availability_schedules?user=…` per member | Stored as returned. The default schedule is used. |
| `events_future.json` | `GET /scheduled_events?organization=…&min_start_time=FROM&max_start_time=TO` with **no status filter** (all pages) | Window `[FROM, TO)`, typically from now to six months out. Keep cancelled events. |
| `events_past.json` | The same call for the last 90 days | Optional. Used only to add hosts to team types whose host list is incomplete. |
| `invitees.json` | `GET /scheduled_events/{uuid}/invitees` for every active event | `{event_uri: [invitee, …]}`. |

## 2. Build the snapshot

```bash
python3 -I scripts/calendly-snapshot.py <inventory_dir> snapshot.json \
  --window-from 2026-10-13T00:00:00Z --window-to 2027-04-13T00:00:00Z \
  --events <inventory_dir>/events_future.json --history <inventory_dir>/events_past.json \
  --invitees <inventory_dir>/invitees.json
```

The builder refuses to run when:

- a member has no usable email;
- an active meeting has no usable invitee (unless you pass `--allow-partial`; such meetings are kept without an invitee, so they are not cancelled as missing);
- a meeting starts outside the window.

`--placeholder` fills in made-up emails for local testing. The app only dry-runs such a snapshot. The snapshot contains invitee contact details: keep it out of the repository and delete it after use.

### People and pages only

When meetings cannot be copied yet (for example, while the MCP gateway redacts invitee emails), build a snapshot without meetings:

```bash
python3 -I scripts/calendly-snapshot.py <inventory_dir> snapshot.json --pages-only \
  --history <inventory_dir>/events_past.json --emails emails.json
```

- `--pages-only` copies people, working hours, teams and booking pages. The events window is empty, so no imported booking is ever treated as missing. Bookings can be imported later with a full snapshot.
- `--emails` is a `{calendly_user_uri: email}` map used for members whose email is redacted. Calendly booking links follow the email local part (`first-last-bigthinkcapital` for `first.last@bigthinkcapital.com`), so the map can be derived from slugs. Review the exceptions by hand.
- A derived email that turns out to be wrong is corrected at sign-in: when no account matches the Microsoft email or user principal name, a single unlinked imported account with the same display name is linked instead (`user.linked` audit entry with `linkedBy: "name"`).

## 3. Dry run, then apply

1. On **Admin > Import**, upload the snapshot with **Apply** unchecked. The report shows counts, timing and warnings. Read the warnings, in particular team pages without hosts and members outside the allowed sign-in domains.
2. Upload again with **Apply** checked. One transaction applies everything, or nothing if anything fails.

Admins can also run both steps through the REST API with an API key: `POST /api/v1/import/calendly` with the snapshot as the JSON body (up to 4 MB) is a dry run, and `POST /api/v1/import/calendly?apply=true` applies it. A refused run returns 409.

What is created:

- **Users.** Created with no Microsoft link, and linked at their first sign-in by email or user principal name. Each gets their default Calendly schedule as working hours (time zone, weekly hours, future date overrides). Per-event-type schedules, minimum notice, daily limits and the booking window are not available from Calendly. Imported pages use the app defaults: 4 hours notice and 60 days ahead.
- **Teams.** One per Calendly team profile, with every listed host plus reps seen on the type's meetings when Calendly's host list is incomplete. Team pages with no matching hosts are marked as needing hosts.
- **Event types.** Inactive. `import_meta` keeps Calendly's `active`, `secret` and `kind` flags. Group events never go live.
- **Bookings.** Upcoming meetings are copied. Each holds the host's time, including Calendly buffers. Overlapping meetings are copied as flagged.

## 4. Go live

Reps are offered as hosts only once they have signed in and connected Outlook. The **Imported booking pages** panel shows Outlook coverage per rep and per team. Use **Go live** on a rep or team, or **Take everything live**, which asks for confirmation. **Pause** returns pages to the dormant state. Every change is audited (`import.calendly.go_live`, `import.calendly.pause`).

Calendly links keep working until you retire them, and a rep can be booked in both systems during the overlap. Outlook busy time protects against double booking once the rep's calendar is connected.

## 5. Keep in sync until Calendly is retired

Pull and import again as often as needed, for example daily during the overlap. Each run:

- applies Calendly cancellations, time changes and host reassignments;
- frees the time of cancelled meetings before holding new ones;
- restores holds that an overlap had dropped;
- cancels imported bookings in the window that Calendly no longer lists.

When more than a quarter of the window's imported bookings (and more than 10) would be cancelled as missing, the run is refused as a probable incomplete pull. A snapshot older than the last applied one is also refused.
