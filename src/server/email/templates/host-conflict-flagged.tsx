import { brand } from "@/theme/brand";
import { formatWhen } from "@/server/email/format";
import { Details, EmailLayout, Paragraph, PrimaryButton, type DetailRow } from "./layout";

/** Host-facing (English) alert that a booking was flagged and needs attention. */
export type HostConflictData = {
  hostName: string;
  eventName: string;
  start: Date;
  end: Date;
  timezone: string;
  inviteeName: string;
  reason: string | null;
  dashboardUrl: string;
  logoUrl: string;
};

export function hostConflictSubject(d: HostConflictData): { subject: string; preview: string } {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  return {
    subject: `Action needed: ${d.eventName} with ${d.inviteeName} on ${when.date}`,
    preview: d.reason ?? "A booking needs your attention.",
  };
}

export function HostConflictFlaggedEmail(d: HostConflictData) {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  const rows: DetailRow[] = [
    { label: "Meeting", value: d.eventName },
    { label: "When", value: `${when.date}, ${when.range} (${when.zoneName})` },
    { label: "Invitee", value: d.inviteeName },
    { label: "What happened", value: d.reason ?? "The booking no longer matches your Outlook calendar." },
  ];
  return (
    <EmailLayout
      lang="en"
      preview={hostConflictSubject(d).preview}
      logoUrl={d.logoUrl}
      heading="A booking needs your attention"
      footer={`${brand.productName} alert.`}
    >
      <Paragraph>Hi {d.hostName},</Paragraph>
      <Paragraph>
        This booking was flagged. The invitee has not been notified. Review it in the dashboard and reschedule or
        cancel if needed.
      </Paragraph>
      <Details rows={rows} />
      <PrimaryButton href={d.dashboardUrl}>Review booking</PrimaryButton>
    </EmailLayout>
  );
}
