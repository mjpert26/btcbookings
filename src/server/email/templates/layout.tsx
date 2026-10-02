import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";
import { brand } from "@/theme/brand";

/** Shared, branded email shell. Inline styles only; email clients ignore stylesheets. */

export const colors = brand.colors;

const font = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";

export function EmailLayout(props: {
  lang: string;
  preview: string;
  logoUrl: string;
  heading: string;
  footer: string;
  children: ReactNode;
}) {
  return (
    <Html lang={props.lang}>
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={{ backgroundColor: colors.surfaceAlt, margin: 0, padding: "24px 0", fontFamily: font }}>
        <Container
          style={{
            backgroundColor: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            maxWidth: 560,
            padding: "32px 32px 24px",
          }}
        >
          <Img src={props.logoUrl} alt={brand.logo.alt} width={150} height={62} style={{ marginBottom: 24 }} />
          <Heading as="h1" style={{ color: colors.navy, fontSize: 22, lineHeight: "30px", margin: "0 0 16px" }}>
            {props.heading}
          </Heading>
          {props.children}
          <Hr style={{ borderColor: colors.border, margin: "28px 0 16px" }} />
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: "18px", margin: 0 }}>{props.footer}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={{ color: colors.ink, fontSize: 15, lineHeight: "24px", margin: "0 0 12px" }}>{children}</Text>;
}

export type DetailRow = { label: string; value: ReactNode };

export function Details({ rows }: { rows: DetailRow[] }) {
  return (
    <Section
      style={{
        backgroundColor: colors.surfaceAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: "16px 20px",
        margin: "16px 0",
      }}
    >
      {rows.map((r) => (
        <div key={r.label} style={{ marginBottom: 10 }}>
          <Text style={{ color: colors.muted, fontSize: 12, fontWeight: 600, letterSpacing: 0.4, margin: 0, textTransform: "uppercase" }}>
            {r.label}
          </Text>
          <Text style={{ color: colors.ink, fontSize: 15, lineHeight: "22px", margin: 0 }}>{r.value}</Text>
        </div>
      ))}
    </Section>
  );
}

export function PrimaryButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: colors.primary,
        borderRadius: 8,
        color: colors.primaryForeground,
        display: "inline-block",
        fontSize: 15,
        fontWeight: 600,
        padding: "12px 20px",
        textDecoration: "none",
      }}
    >
      {children}
    </Button>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} style={{ color: colors.primary, textDecoration: "underline" }}>
      {children}
    </Link>
  );
}
