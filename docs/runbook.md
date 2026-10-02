# Runbook

Operational procedures for BTC Scheduler. Each section has a stable anchor that the app links to.

## Slack removals blocked

<a id="slack-removals-blocked"></a>

**Symptom:** a Slack channel config shows health "error" with "Slack workspace settings block
removals by apps (restricted_action)". Invites still work; removals do not.

**Cause:** the workspace's Channel Management permissions do not allow the BTC Scheduler bot
to remove members, so `conversations.kick` returns `restricted_action`.

**Fix (Workspace Owner or Admin):**

1. In Slack, open **Settings & administration > Workspace settings**.
2. Open the **Permissions** tab and expand **Channel Management**.
3. Set "People who can remove members from public channels" (and, for private channels, the
   private channel equivalent) to a value that includes the app, for example
   "Everyone, except guests". Save.
4. On Enterprise Grid, check that no org-level policy overrides the workspace setting.
5. In BTC Scheduler, run a health check on the channel, then a full resync so pending
   removals are applied.

If the organization does not want apps to remove members, switch the channel to
**add only** mode instead.
