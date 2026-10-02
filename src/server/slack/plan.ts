/**
 * Pure decision logic for Slack channel sync. No I/O, so it is unit tested directly.
 *
 * Direction is one way: team membership status decides Slack channel membership.
 * Slack membership never changes team membership.
 */

export type SlackMode = "add_only" | "add_and_remove";
export type MemberStatus = "active" | "paused" | "pending_onboarding";

export type ChannelConfig = {
  id: string;
  team_id: string;
  channel_id: string;
  channel_name: string | null;
  mode: SlackMode;
  dry_run: boolean;
  protected_slack_user_ids: string[];
  notify_channel_id: string | null;
};

/** `removed` means the team member row no longer exists. */
export type MemberState = MemberStatus | "removed";

export type PlannedAction =
  | { action: "invite"; reason: string }
  | { action: "kick"; reason: string }
  | { action: "skip"; reason: string; code: string }
  | { action: "none"; reason: string };

/** The action implied by a member's status alone, before the Slack user id is known. */
export function intendedAction(mode: SlackMode, state: MemberState): "invite" | "kick" | "none" {
  if (state === "active") return "invite";
  if (state === "pending_onboarding") return "none";
  // paused or removed
  return mode === "add_and_remove" ? "kick" : "none";
}

/**
 * Decides what to do for one member in one channel.
 * Protected users are never kicked. Pending members are neither invited nor kicked.
 */
export function planMemberAction(
  channel: Pick<ChannelConfig, "mode" | "protected_slack_user_ids">,
  state: MemberState,
  slackUserId: string | null,
): PlannedAction {
  const intended = intendedAction(channel.mode, state);
  if (intended === "none") {
    if (state === "pending_onboarding") return { action: "none", reason: "Member is pending onboarding" };
    return { action: "none", reason: "Channel is add-only; members are never removed" };
  }
  if (!slackUserId) {
    return { action: "skip", reason: "No Slack account found for this member", code: "users_not_found" };
  }
  if (intended === "kick") {
    if (channel.protected_slack_user_ids.includes(slackUserId)) {
      return { action: "skip", reason: "User is protected from removal in this channel", code: "protected_user" };
    }
    return { action: "kick", reason: state === "removed" ? "Member removed from team" : "Member paused" };
  }
  return { action: "invite", reason: "Member is active" };
}

export type PreviewMember = {
  teamMemberId: string;
  email: string;
  status: MemberStatus;
  slackUserId: string | null;
};

export type ChannelPreview = {
  wouldAdd: PreviewMember[];
  wouldRemove: PreviewMember[];
  /** Paused members that would be removed but are protected. */
  protectedKept: PreviewMember[];
  /** Members whose Slack account could not be resolved by email. */
  unresolved: PreviewMember[];
  /** Members already in the desired state. */
  unchanged: number;
};

/**
 * Compares team members with the current channel member list. Only team members are ever
 * proposed for removal; people in the channel who are not on the team are left alone.
 */
export function computePreview(
  channel: Pick<ChannelConfig, "mode" | "protected_slack_user_ids">,
  members: PreviewMember[],
  channelMemberIds: Iterable<string>,
): ChannelPreview {
  const inChannel = new Set(channelMemberIds);
  const out: ChannelPreview = { wouldAdd: [], wouldRemove: [], protectedKept: [], unresolved: [], unchanged: 0 };
  for (const m of members) {
    const intended = intendedAction(channel.mode, m.status);
    if (intended === "none") {
      out.unchanged++;
      continue;
    }
    if (!m.slackUserId) {
      out.unresolved.push(m);
      continue;
    }
    const present = inChannel.has(m.slackUserId);
    if (intended === "invite") {
      if (present) out.unchanged++;
      else out.wouldAdd.push(m);
    } else if (!present) {
      out.unchanged++;
    } else if (channel.protected_slack_user_ids.includes(m.slackUserId)) {
      out.protectedKept.push(m);
    } else {
      out.wouldRemove.push(m);
    }
  }
  return out;
}

/** Slack conversation ids for public and private channels. Matches the DB check constraint. */
export const CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/;
/** Slack user ids (U for workspace users, W for Enterprise Grid org users). */
export const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;

export const BOT_NOT_IN_CHANNEL_MESSAGE =
  "The bot is not a member of this private channel. In Slack, open the channel and run /invite @BTC Scheduler, then run a health check.";
export const REMOVALS_BLOCKED_MESSAGE =
  "Slack workspace settings block removals by apps (restricted_action). A workspace admin must allow the app to remove members. See docs/runbook.md#slack-removals-blocked.";

/** Human-readable reason for an admin notice, from the membership event source. */
export function noticeReason(source: string | null | undefined): string {
  switch (source) {
    case "poll":
    case "push":
      return "queue sync";
    case "manual":
    case "admin":
      return "admin change";
    case "system":
      return "onboarding";
    case "resync":
      return "full resync";
    default:
      return "membership sync";
  }
}

export function noticeText(
  action: "invite" | "kick",
  slackUserId: string,
  channelId: string,
  teamName: string,
  reason: string,
): string {
  const verb = action === "invite" ? "added" : "removed";
  const prep = action === "invite" ? "to" : "from";
  return `BTC Scheduler ${verb} <@${slackUserId}> ${prep} <#${channelId}> (team: ${teamName}, reason: ${reason})`;
}
