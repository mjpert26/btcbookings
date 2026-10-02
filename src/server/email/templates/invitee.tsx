import { Section, Text } from "@react-email/components";
import type { Locale } from "@/i18n/locales";
import { brand } from "@/theme/brand";
import { formatWhen } from "@/server/email/format";
import { translator } from "@/server/email/i18n";
import { colors, Details, EmailLayout, Paragraph, PrimaryButton, TextLink, type DetailRow } from "./layout";

/** Data every invitee-facing email needs. Built by the email job from fresh booking state. */
export type InviteeEmailData = {
  locale: Locale;
  inviteeName: string;
  eventName: string;
  start: Date;
  end: Date;
  timezone: string;
  hostNames: string[];
  locationType: "teams" | "phone" | "in_person" | "custom";
  locationDetail: string | null;
  onlineMeetingUrl: string | null;
  /** `${APP_BASE_URL}/b/<token>`; null when the token is unavailable. */
  manageUrl: string | null;
  bookAgainUrl: string | null;
  logoUrl: string;
};

export type InviteeKind = "confirmed" | "rescheduled" | "cancelled" | "reminder";

export function inviteeSubject(kind: InviteeKind, d: InviteeEmailData): { subject: string; preview: string } {
  const t = translator(d.locale, "email");
  const when = formatWhen(d.start, d.end, d.timezone, d.locale);
  const vars = { event: d.eventName, date: when.date, time: when.time };
  return { subject: t(`${kind}.subject`, vars), preview: t(`${kind}.preview`, vars) };
}

export function locationText(d: InviteeEmailData): { text: string; url: string | null } {
  const tp = translator(d.locale, "public");
  const t = translator(d.locale, "email");
  if (d.locationType === "teams") {
    return d.onlineMeetingUrl
      ? { text: t("teamsJoin"), url: d.onlineMeetingUrl }
      : { text: `${tp("location.teams")}. ${t("teamsPending")}`, url: null };
  }
  const label = tp(`location.${d.locationType}`);
  return { text: d.locationDetail ? `${label}: ${d.locationDetail}` : label, url: null };
}

export function InviteeEmail({ kind, data }: { kind: InviteeKind; data: InviteeEmailData }) {
  const t = translator(data.locale, "email");
  const when = formatWhen(data.start, data.end, data.timezone, data.locale);
  const { preview } = inviteeSubject(kind, data);
  const loc = locationText(data);
  const cancelled = kind === "cancelled";
  const rows: DetailRow[] = [
    { label: t("when"), value: `${when.date}, ${when.range}` },
    ...(data.hostNames.length ? [{ label: t("with"), value: data.hostNames.join(", ") }] : []),
    ...(!cancelled
      ? [{ label: t("where"), value: loc.url ? <TextLink href={loc.url}>{loc.text}</TextLink> : loc.text }]
      : []),
  ];
  return (
    <EmailLayout
      lang={data.locale}
      preview={preview}
      logoUrl={data.logoUrl}
      heading={t(`${kind}.heading`)}
      footer={t("footer", { brand: brand.name })}
    >
      <Paragraph>{t("greeting", { name: data.inviteeName })}</Paragraph>
      <Paragraph>{t(`${kind}.body`)}</Paragraph>
      <Text style={{ color: colors.navy, fontSize: 17, fontWeight: 700, margin: "20px 0 0" }}>{data.eventName}</Text>
      <Details rows={rows} />
      <Text style={{ color: colors.muted, fontSize: 13, margin: "0 0 20px" }}>
        {t("timezone", { tz: `${when.zoneName} (${data.timezone})` })}
      </Text>
      {!cancelled && data.manageUrl ? (
        <Section>
          <Paragraph>{t("manageIntro")}</Paragraph>
          <PrimaryButton href={data.manageUrl}>{t("manageLink")}</PrimaryButton>
        </Section>
      ) : null}
      {cancelled && data.bookAgainUrl ? (
        <Section>
          <PrimaryButton href={data.bookAgainUrl}>{t("cancelled.bookAgain")}</PrimaryButton>
        </Section>
      ) : null}
    </EmailLayout>
  );
}
