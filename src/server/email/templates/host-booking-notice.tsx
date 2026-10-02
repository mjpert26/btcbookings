import { brand } from "@/theme/brand";
import { formatWhen } from "@/server/email/format";
import { Details, EmailLayout, Paragraph, PrimaryButton, type DetailRow } from "./layout";

/** Host-facing (English) notice of a booking change, for hosts with notify_host_by_email on. */
export type HostNoticeData = {
  kind: "created" | "rescheduled" | "cancelled";
  hostName: string;
  eventName: string;
  start: Date;
  end: Date;
  timezone: string;
  inviteeName: string;
  inviteeEmail: string;
  inviteePhone: string | null;
  inviteeTimezone: string;
  answers: { label: string; value: string }[];
  cancelReason: string | null;
  dashboardUrl: string;
  logoUrl: string;
};

const HEADINGS: Record<HostNoticeData["kind"], string> = {
  created: "New meeting booked",
  rescheduled: "Meeting updated",
  cancelled: "Meeting cancelled",
};

export function hostNoticeSubject(d: HostNoticeData): { subject: string; preview: string } {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  const verb = d.kind === "created" ? "New booking" : d.kind === "rescheduled" ? "Updated" : "Cancelled";
  return {
    subject: `${verb}: ${d.eventName} with ${d.inviteeName} on ${when.date}`,
    preview: `${d.inviteeName}, ${when.date} at ${when.time}`,
  };
}

export function HostBookingNoticeEmail(d: HostNoticeData) {
  const when = formatWhen(d.start, d.end, d.timezone, "en");
  const rows: DetailRow[] = [
    { label: "Meeting", value: d.eventName },
    { label: "When", value: `${when.date}, ${when.range} (${when.zoneName})` },
    { label: "Invitee", value: `${d.inviteeName} <${d.inviteeEmail}>` },
    ...(d.inviteePhone ? [{ label: "Phone", value: d.inviteePhone }] : []),
    { label: "Invitee time zone", value: d.inviteeTimezone },
    ...d.answers.map((a) => ({ label: a.label, value: a.value })),
    ...(d.kind === "cancelled" && d.cancelReason ? [{ label: "Reason", value: d.cancelReason }] : []),
  ];
  return (
    <EmailLayout
      lang="en"
      preview={hostNoticeSubject(d).preview}
      logoUrl={d.logoUrl}
      heading={HEADINGS[d.kind]}
      footer={`${brand.productName}. You receive these notices because host email notifications are on in your settings.`}
    >
      <Paragraph>Hi {d.hostName},</Paragraph>
      <Details rows={rows} />
      <PrimaryButton href={d.dashboardUrl}>Open dashboard</PrimaryButton>
    </EmailLayout>
  );
}
