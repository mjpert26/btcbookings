# Slack setup

BTC Scheduler keeps Slack channels, and optionally one Slack user group per team, in step
with team membership. The direction is one way:

Salesforce Queue -> team member status in BTC Scheduler -> Slack channels and user group.

The full chain from the queue to booking pages and Slack is described in
`docs/queue-slack-sync.md`.

Slack membership never changes team membership. The app uses a bot token only; it receives
no events from Slack.

## 1. Create the app from the manifest

1. Sign in to the target workspace in a browser, then open https://api.slack.com/apps.
2. Choose **Create New App**, then **From a manifest**.
3. Pick the workspace (on Enterprise Grid, see section 3 first).
4. Paste the contents of `slack/manifest.yml` (YAML tab) and continue.
5. Review the summary. The bot scopes must be exactly:
   `channels:read`, `groups:read`, `channels:manage`, `groups:write`, `channels:join`,
   `users:read`, `users:read.email`, `chat:write`, `usergroups:read`, `usergroups:write`.
   An app created before the user group scopes were added must be updated from the
   manifest and reinstalled (section 2) before a user group link is turned live.
6. Choose **Create**.
7. Optional: under **Basic Information > Display Information**, upload the BTC app icon.

If manifest validation rejects the bot display name, change `features.bot_user.display_name`
to `btc-scheduler` and try again. The app name stays "BTC Scheduler".

## 2. Install to the workspace

1. In the app settings, open **Install App** and choose **Install to Workspace**
   (or **Request to Install** if the workspace requires approval).
2. Approve the requested permissions.
3. Copy the **Bot User OAuth Token**. It starts with `xoxb-`. Treat it as a secret.

Approval: many workspaces only let Workspace Owners or Admins install apps, or require an
app approval request. If you see **Request to Install**, a Workspace Owner or Admin (or an
Org Owner or Admin on Enterprise Grid) must approve it under app management before the token
is issued.

## 3. Enterprise Grid notes

- To install once at the organization level, set `settings.org_deploy_enabled: true` in the
  manifest before creating the app. An Org Owner or Admin then installs it to the org and
  adds it to each workspace that has team channels.
- Users in Grid may have `W...` user ids. Protected user ids accept both `U...` and `W...`.
- Org-level policies can block apps from managing channels. In that case Slack returns
  `restricted_action`, `enterprise_is_restricted` or `team_access_not_granted`, which the
  admin UI shows as a channel error.

## 4. Configure Vercel

1. In the Vercel project, open **Settings > Environment Variables**.
2. Add `SLACK_BOT_TOKEN` with the `xoxb-` token for the Production environment (and Preview
   only if previews should talk to the real workspace; normally they should not).
3. Optional: add `SLACK_ADMIN_NOTIFY_CHANNEL` with a channel id (for example `C0123456789`).
   Admin notices go to a channel config's own notice channel when set, otherwise to this one.
4. Redeploy so the functions pick up the new variables.

The token is read only on the server. It is never stored in the database or written to logs.

## 5. Add the bot to channels

- **Private channels:** the bot cannot join on its own. Open the channel in Slack and run
  `/invite @BTC Scheduler`. Until then the channel shows health "bot not in channel".
- **Public channels:** nothing to do. The first sync calls `conversations.join`
  (`channels:join` scope) and retries.
- **Notice channel:** invite the bot to the channel that receives admin notices. The app
  does not request `chat:write.public`, so it can only post where it is a member.

To find a channel id: open the channel, click its name, and copy the id at the bottom of the
About tab (it starts with `C`; older private channels may start with `G`).

## 6. Allow the app to remove members

Channels in **add and remove** mode need the app to be allowed to remove people.

Workspace Owners control this under **Settings & administration > Workspace settings >
Permissions > Channel Management**:

- "People who can remove members from public channels"
- "People who can remove members from private channels"

If the bot is not allowed, Slack returns `restricted_action` and the channel shows the error
"Slack workspace settings block removals by apps". A Workspace Owner or Admin must change the
setting (see `docs/runbook.md#slack-removals-blocked`). Invites keep working in the meantime.

## 7. Link a channel to a team (dry-run workflow)

1. An admin links the channel to a team with its channel id, the mode (`add only` or
   `add and remove`), any protected Slack user ids (for example managers who must never be
   removed) and an optional notice channel. The app checks the channel with
   `conversations.info` and records its name and health.
2. **New channel links always start in dry-run mode.** Sync jobs record what they would do
   (`would_do`) and make no invite or remove calls.
3. Open the channel preview. It compares team members with the current channel members and
   lists who would be added, who would be removed, protected users who would be kept, and
   members without a Slack account. Review it with the team lead.
4. Check the recent dry-run actions for the channel.
5. When the preview is right, turn dry run off. This change is audited.
6. Optionally run a full resync, which queues a sync for every team member.

Rules the sync follows:

- Active members are invited in both modes.
- Paused members, and members removed from the team, are removed only in `add and remove`
  mode. `add only` channels never remove anyone.
- Members pending onboarding are not invited until they become active.
- Protected users are never removed.
- Workspace owners, workspace admins and bot users are never removed. The app checks each
  person with `users.info` before a removal; if Slack cannot confirm the person, nothing is
  removed.
- People in the channel who are not on the team are never touched.
- `#general` and the bot itself are skipped.
- A member whose email has no Slack account is recorded as a warning and not retried.
- Teams with no Slack link get no Slack jobs at all.
- Without `SLACK_BOT_TOKEN`, Slack jobs succeed with `skipped: slack_not_configured` and
  change nothing.

## 8. Link a user group to a team

A team can have one Slack user group (for example `@partner-team`) that follows its roster
the same way as its channels. Slack user groups need a Standard plan or above.

1. In Slack, open **People > User groups**, open the group and copy its id (it starts
   with `S`).
2. On **Admin > Teams > (team) > Slack**, under **Slack user group**, enter the id, an
   optional handle for display, the mode and any protected user ids. Only global admins can
   do this. The app reads the group once with `usergroups.users.list` to check access.
3. **The link starts in dry-run mode.** Membership changes record `would_do` actions and
   make no `usergroups.users.update` calls. Review **Recent user group actions**.
4. Turn dry run off when the actions look right. Optionally run **Full resync** to queue a
   sync for every team member.

Rules: active members are added; in `add and remove` mode paused and removed members are
taken out. Only team members are ever added or removed; everyone else in the group stays.
Protected users, workspace owners and admins, and bots are never removed. Slack does not
allow an empty user group, so removing the last member is skipped (disable the group in
Slack instead).

Workspace owners can restrict who may create and change user groups in the workspace
permission settings (check the current menu names in Slack's help centre). If the app is
not allowed, Slack returns `permission_denied` and the user group shows an error.

## 9. Troubleshooting

| Health or error | Meaning | Fix |
|---|---|---|
| bot not in channel | Private channel the bot is not in, or a wrong channel id. | `/invite @BTC Scheduler` in the channel, then run a health check. |
| error: removals blocked (`restricted_action`) | Workspace settings stop the app removing members. | Section 6. |
| error: missing scope | The installed app lacks a scope. | Update the app from `slack/manifest.yml` and reinstall. |
| error: token invalid or revoked | `SLACK_BOT_TOKEN` is wrong or the app was uninstalled. | Reinstall, update the variable, redeploy. |
| error: archived | The channel was archived. | Unarchive it or remove the channel link. |
| warning: users_not_found | The member's email does not match a Slack account. | Fix the email in Slack or in the roster. |
| skipped: workspace_admin / bot_user | The person is a workspace owner, admin or a bot. | Expected; remove them by hand if needed. |
| user group error: not found (`no_such_subteam`) | Wrong user group id, or the group was deleted. | Check the id and relink. |
| user group error: `permission_denied` | Workspace settings stop the app changing user groups. | Section 8. |
| user group error: `plan_upgrade_required` | The workspace plan has no user groups. | Unlink the user group. |
| user group skipped: empty_group | Removing the member would leave the group empty. | Disable the group in Slack if it should be empty. |
