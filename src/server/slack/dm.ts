import { formatWhen } from "@/server/email/format";
import { leadTimeLabel, type AgentReminderData } from "@/server/email/reminder-rules";

/**
 * Slack direct-message reminder text for an agent. Pure, so it is unit-tested directly.
 * Uses Slack mrkdwn; user-provided values are escaped so they cannot form links or mentions.
 */

/** Escapes the three characters Slack treats as control characters in message text. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function link(url: string, text: string): string {
  // A URL containing "|" or ">" would break the link syntax; fall back to the bare URL.
  return /[|<>\s]/.test(url) ? slackEscape(url) : `<${url}|${slackEscape(text)}>`;
}

export function agentReminderSlackText(d: AgentReminderData): string {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  const lines = [
    `*Reminder: ${slackEscape(d.eventName)} starts in ${leadTimeLabel(d.leadMin)}*`,
    ...(d.partnerName ? [`*Partner:* ${slackEscape(d.partnerName)}`] : []),
    `*When:* ${when.date}, ${when.range} (${when.zoneName})`,
    `*Merchant:* ${slackEscape(d.inviteeName)} (${slackEscape(d.inviteeEmail)})`,
    ...(d.inviteePhone ? [`*Phone:* ${slackEscape(d.inviteePhone)}`] : []),
    `*Meeting:* ${d.meeting.url ? link(d.meeting.url, d.meeting.text) : slackEscape(d.meeting.text)}`,
    ...d.answers.map((a) => `*${slackEscape(a.label)}:* ${slackEscape(a.value)}`),
    link(d.bookingUrl, "Open booking"),
  ];
  return lines.join("\n").slice(0, 3900);
}
