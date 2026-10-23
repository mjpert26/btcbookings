# Queue to booking page to Slack sync

How a change to a partner's Salesforce Queue reaches the partner's booking pages and Slack
(Jira BTCSCHED-49, 50 and 51). The direction is one way:

Salesforce Queue -> team membership in BTC Scheduler -> booking pages -> Slack channels and user group.

Slack and the booking pages never change team membership, and nothing is written to
Salesforce.

## What happens when a rep leaves a queue

The n8n poller posts a queue snapshot every 2 minutes (and Salesforce can push single
changes); see `docs/n8n-workflows.md`. For each team linked to the queue, one database
transaction (`src/server/sync/apply.ts`) does all of the following:

1. **Membership ends.** The rep's `team_members` row is set to `paused` with
   `paused_reason = 'removed_from_queue'`. Rows are never deleted, so round-robin history is
   kept if the rep comes back.
2. **The rep stops being offered.** The booking engine only offers members whose status is
   `active` (`loadPool` in `src/server/booking/load.ts`). This covers round-robin pools,
   collective host lists and pages with their own host list (`event_type_hosts`). A page
   whose host list contained only that rep shows no times until an admin changes its hosts.
3. **Upcoming bookings follow the team's removal policy.** Bookings on the team's pages
   where the rep is an active host (primary or collective), in the future:
   - `reassign`: each confirmed booking gets a `booking_reassign` job. The job moves it to
     another free member (round-robin), removes the rep from a collective booking, or flags
     the booking when nobody can take it. If the rep is back in the queue (status `active`
     or `pending_onboarding` on the team) when the job runs, the job does nothing
     (`result.skipped = "host_active"`) and the booking stays with the rep. A reassignment
     does not update Salesforce: the Lead keeps its owner (see `docs/n8n-workflows.md`,
     "Host reassignments").
   - `keep_bookings`: the bookings stay with the rep.
   - Bookings kept for any reason (keep_bookings, already flagged, or imported from
     Calendly, which never produce outbound work) are listed in a `removed_member_bookings`
     alert and in **Upcoming bookings to review** on the team's queue sync page. If the
     rep is added back to the queue, the sync resolves their open alerts in the same
     transaction (audit action `sync_alert.auto_resolved`).
4. **Slack jobs are queued** through the `app.jobs` outbox for the team's linked channels
   (`slack_membership_sync`) and linked user group (`slack_usergroup_sync`). A team with no
   Slack link gets no Slack jobs.
5. **Records.** A membership event, an audit entry with `via = 'sync'`
   (`team_member.queue_sync.add|remove|reinstate|promote`) and a run row in
   `app.queue_sync_runs` are written.

When a rep is added to a queue (or added back), the same transaction adds or reinstates the
member. They are `active` when they have signed in with a healthy Outlook connection and
`pending_onboarding` until then. Active members are offered on the team's pages that use
all members, but not on pages with their own host list (an admin adds them there), and the
Slack jobs invite them.

Unchanged rules:

- Manual members (added in the app) are never changed by the queue sync.
- Members paused by an admin are not reinstated by the sync.
- The mass-removal safety rail and the push removal budget still apply
  (`docs/salesforce-changes.md`, PLAN 4.5).

## Slack

Both Slack jobs read the member's current status when they run, are idempotent, and
respect rate limits: HTTP 429 or `ratelimited` reschedules the job for the `Retry-After`
time.

- **Channels** (existing): see `docs/slack-setup.md`.
- **User group** (new, optional, one per team): `app.team_slack_usergroups`. Only global
  admins can link, edit or unlink it; team admins can see it. Each job reads the group with
  `usergroups.users.list`, adds or removes only that member, and writes the full list back
  with `usergroups.users.update`, under an advisory lock per group so two jobs cannot
  overwrite each other. The link is read again after the lock is taken, so a job that waited
  uses the current dry-run flag, mode and protected users, and stops if the group was
  unlinked; an unlink waits for a running job to finish. Everyone else in the group is left
  alone. Removing the last member is skipped because Slack does not accept an empty group.
  A user group can be linked to one team only, so a removal on one team never takes a rep
  out of a group they still belong to through another team. (Channels can still be linked
  to more than one team; a channel shared by two teams follows whichever team changed last.)
- **Mode:** new channel and user group links default to `add only`, which adds members but
  never removes anyone. Set the mode to `add and remove` for reps who leave the queue to be
  taken out.
- **Never removed:** workspace owners, workspace admins and bot users (including the app's
  own bot) are checked with `users.info` before any channel or user group removal, plus
  each link's protected user list. If Slack cannot confirm a user, nothing is removed.
- **Dry run:** new channel and user group links start in dry-run mode and only record what
  they would do (`would_do`).
- **Not configured:** without `SLACK_BOT_TOKEN`, Slack jobs succeed with the result
  `{ "skipped": "slack_not_configured" }`, log one line, and change nothing.

Scopes for the user group: `usergroups:read` and `usergroups:write` (in
`slack/manifest.yml`). Workspace settings can limit who may change user groups; if the app
is not allowed, the group shows an error and nothing is changed.

## Teams without links

Sync and Slack work only run for teams with a linked Salesforce Queue or Slack link. The
partner teams imported from Calendly have neither, so no snapshot, push, health check or
Slack job touches them. Admin changes to their rosters write membership events and audit
entries only. They appear on the sync status page only as a count.

## Sync status

**Admin > Sync status** (`/admin/sync`) lists every team with a queue or Slack link:

- queue sync health and last sync time;
- the last run (snapshot or push, result, members added and removed) and the last run that
  changed the roster;
- pending, retrying and failed Slack jobs;
- current errors (queue sync, Slack channels, the user group and failed Slack jobs).

The team's queue sync page (`/admin/teams/<id>/sync`) shows the same status for one team,
plus the upcoming bookings to review. Repeated no-change runs are stored as one row with a
repeat count; rows not seen for 30 days are purged by the queue sync health cron.

## Rollout

1. Apply migration `20261023090000_sync_chain.sql`. Besides the new tables, it changes
   behaviour for existing teams as soon as it is deployed:
   - `app.enqueue_membership_slack_sync()` queues Slack jobs only for teams with a Slack
     channel or user group linked. Admin roster changes on teams without a Slack link no
     longer queue (no-op) Slack jobs.
   - `app.enqueue_member_reassignments()` also reassigns bookings where the paused rep is a
     collective (non-primary) host, for an admin pause or a queue removal under removal
     policy `reassign`. For those bookings this means Graph calendar delete and update jobs
     and cancelled host reminders. Bookings imported from Calendly are skipped.
   The same deploy also changes the Slack jobs: without `SLACK_BOT_TOKEN` they succeed with
   `slack_not_configured` instead of failing, and every channel kick (and user group
   removal) is preceded by one `users.info` call so that workspace owners, admins and bots
   are never removed.
2. Update the Slack app from `slack/manifest.yml` and reinstall it so the token has the
   `usergroups:*` scopes.
3. For each partner team: link its Salesforce Queue, then link its channel and user group.
   Each user group can be linked to one team only.
4. Review the dry-run actions (`would_do`) for the channel and the user group.
5. Links default to mode `add only`, which never removes anyone. Where reps who leave the
   queue should be taken out of the channel or user group, set the mode to
   `add and remove`.
6. Turn dry run off.

## Tests

`tests/integration/sync-chain.test.ts` runs the chain end to end with Salesforce (behind
the n8n poller) and Slack mocked: removal, slots, reassignment or review, Slack channel and
user group, and the reverse for an addition. Unit tests for the user group plan are in
`tests/unit/slack-usergroup.test.ts`.
