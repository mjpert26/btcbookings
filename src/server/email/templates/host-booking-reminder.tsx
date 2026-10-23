import { brand } from "@/theme/brand";
import { formatWhen } from "@/server/email/format";
import { leadTimeLabel, type AgentReminderData } from "@/server/email/reminder-rules";
import { Details, EmailLayout, Paragraph, PrimaryButton, TextLink, type DetailRow } from "./layout";

/** Agent (host) reminder before a meeting. English; times in the agent's time zone. */
export type HostReminderData = AgentReminderData & { logoUrl: string };

export function hostReminderSubject(d: HostReminderData): { subject: string; preview: string } {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  const partner = d.partnerName ? ` (${d.partnerName})` : "";
  return {
    subject: `Reminder: ${d.eventName} with ${d.inviteeName}${partner} at ${when.time}`,
    preview: `Starts in ${leadTimeLabel(d.leadMin)}: ${when.date} at ${when.time}`,
  };
}

export function HostBookingReminderEmail(d: HostReminderData) {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  const rows: DetailRow[] = [
    { label: "Meeting", value: d.eventName },
    ...(d.partnerName ? [{ label: "Partner", value: d.partnerName }] : []),
    { label: "When", value: `${when.date}, ${when.range} (${when.zoneName})` },
    { label: "Merchant", value: `${d.inviteeName} <${d.inviteeEmail}>` },
    ...(d.inviteePhone ? [{ label: "Phone", value: d.inviteePhone }] : []),
    { label: "Where", value: d.meeting.url ? <TextLink href={d.meeting.url}>{d.meeting.text}</TextLink> : d.meeting.text },
    ...d.answers.map((a) => ({ label: a.label, value: a.value })),
  ];
  return (
    <EmailLayout
      lang="en"
      preview={hostReminderSubject(d).preview}
      logoUrl={d.logoUrl}
      heading={`Your meeting starts in ${leadTimeLabel(d.leadMin)}`}
      footer={`${brand.productName}. Reminders for this booking page are set by its owner.`}
    >
      <Paragraph>Hi {d.hostName},</Paragraph>
      <Details rows={rows} />
      <PrimaryButton href={d.bookingUrl}>Open booking</PrimaryButton>
    </EmailLayout>
  );
}
