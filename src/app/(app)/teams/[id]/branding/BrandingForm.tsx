"use client";

import { useState, type CSSProperties } from "react";
import { ActionForm } from "@/components/ui/Form";
import { Checkbox, Input, Textarea } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/lib/form-state";
import { accessibleAccent, HEX_COLOR, MIN_TEXT_CONTRAST, type PageSettings } from "@/server/teams/page-settings";
import { brand } from "@/theme/brand";

type Toggle = { key: keyof PageSettings & `show${string}`; label: string; hint: string };

const TOGGLES: Toggle[] = [
  { key: "showPartnerLogo", label: "Show partner logo", hint: "Shown in the page header when a logo is uploaded." },
  { key: "showBtcLogo", label: "Show Big Think Capital logo", hint: "Shown in the page header next to the partner name." },
  { key: "showHostPhoto", label: "Show host photo", hint: "On the booking confirmation page." },
  { key: "showHostName", label: "Show host name", hint: "On the booking confirmation page." },
  { key: "showDuration", label: "Show meeting length", hint: "On the event list and booking pages." },
  { key: "showDescription", label: "Show event description", hint: "On the event list and booking pages." },
];

export function BrandingForm({
  action,
  initial,
  teamName,
  logoUrl,
}: {
  action: FormAction;
  initial: PageSettings;
  teamName: string;
  logoUrl: string | null;
}) {
  const [s, setS] = useState({
    displayName: initial.displayName ?? "",
    accentColor: initial.accentColor ?? "",
    heading: initial.heading ?? "",
    intro: initial.intro ?? "",
    showPartnerLogo: initial.showPartnerLogo,
    showBtcLogo: initial.showBtcLogo,
    showHostPhoto: initial.showHostPhoto,
    showHostName: initial.showHostName,
    showDuration: initial.showDuration,
    showDescription: initial.showDescription,
  });
  const set = <K extends keyof typeof s>(key: K, value: (typeof s)[K]) => setS((prev) => ({ ...prev, [key]: value }));
  const validHex = HEX_COLOR.test(s.accentColor);
  const accent = accessibleAccent(validHex ? s.accentColor : null);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ActionForm action={action} className="space-y-4" aria-label="Partner page settings">
        <Input
          label="Display name"
          name="displayName"
          maxLength={80}
          value={s.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          placeholder={teamName}
          hint="The partner name shown on public pages. Leave empty to use the team name."
        />
        <div className="flex items-end gap-3">
          <Input
            label="Accent color"
            name="accentColor"
            value={s.accentColor}
            onChange={(e) => set("accentColor", e.target.value)}
            placeholder={brand.colors.primary}
            maxLength={7}
            hint="Hex color for buttons and links. Leave empty for BTC blue."
            wrapperClassName="flex-1"
          />
          <input
            type="color"
            aria-label="Pick accent color"
            value={validHex ? s.accentColor : brand.colors.primary}
            onChange={(e) => set("accentColor", e.target.value.toUpperCase())}
            className="mb-6 h-10 w-12 cursor-pointer rounded-lg border border-border bg-surface p-1"
          />
        </div>
        {accent.fellBack ? (
          <p role="status" className="text-xs font-medium text-warning">
            This color has a contrast of {accent.ratio?.toFixed(2)}:1 with white, below the {MIN_TEXT_CONTRAST}:1 needed for readable text.
            Public pages will use BTC blue instead. Choose a darker color.
          </p>
        ) : null}
        <Input
          label="Heading"
          name="heading"
          maxLength={120}
          value={s.heading}
          onChange={(e) => set("heading", e.target.value)}
          hint="Shown above the list of meetings and on each booking page. Optional."
        />
        <Textarea
          label="Intro"
          name="intro"
          maxLength={1000}
          rows={4}
          value={s.intro}
          onChange={(e) => set("intro", e.target.value)}
          hint={`Plain text, up to 1,000 characters (${s.intro.length} used). Replaces the team description on public pages.`}
        />
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium text-navy">Show on public pages</legend>
          {TOGGLES.map((t) => (
            <Checkbox key={t.key} name={t.key} label={t.label} hint={t.hint} checked={s[t.key]} onChange={(e) => set(t.key, e.target.checked)} />
          ))}
        </fieldset>
        <SubmitButton>Save branding</SubmitButton>
      </ActionForm>

      <BrandingPreview
        name={s.displayName.trim() || teamName}
        heading={s.heading.trim()}
        intro={s.intro.trim()}
        accent={accent.color}
        logoUrl={s.showPartnerLogo ? logoUrl : null}
        showBtcLogo={s.showBtcLogo}
        showDuration={s.showDuration}
        showDescription={s.showDescription}
      />
    </div>
  );
}

export function LogoUploadForm({ action, hasLogo }: { action: FormAction; hasLogo: boolean }) {
  return (
    <ActionForm action={action} aria-label="Upload partner logo">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input
          label={hasLogo ? "Replace logo" : "Upload logo"}
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          required
          wrapperClassName="flex-1"
          hint="PNG, JPEG or WebP, up to 512 KB and 4096 pixels per side. SVG is not accepted. A wide logo about 80 pixels tall looks best."
        />
        <SubmitButton variant="secondary" pendingLabel="Uploading…">
          Upload
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

function BrandingPreview(props: {
  name: string;
  heading: string;
  intro: string;
  accent: string;
  logoUrl: string | null;
  showBtcLogo: boolean;
  showDuration: boolean;
  showDescription: boolean;
}) {
  const style = { "--btc-primary": props.accent } as CSSProperties;
  return (
    <figure className="self-start" aria-label="Preview of the partner page">
      <figcaption className="mb-2 text-sm font-medium text-navy">Preview</figcaption>
      <div style={style} className="overflow-hidden rounded-brand border border-border bg-surface-alt">
        <div className="flex items-center gap-3 border-b border-border bg-white px-4 py-3">
          {props.logoUrl ? (
            // The current logo, served by /api/public/team-logo.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={props.logoUrl} alt="" className="h-8 w-auto max-w-32 object-contain" />
          ) : null}
          <span className="truncate font-heading font-semibold text-navy">{props.name}</span>
          {props.showBtcLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logo.light.src} alt="Big Think Capital" className="h-6 w-auto border-l border-border pl-3" />
          ) : null}
        </div>
        <div className="p-4">
          <p className="text-center font-heading text-lg font-bold text-navy">{props.heading || props.name}</p>
          {props.intro ? <p className="mt-1 whitespace-pre-line text-center text-sm text-muted">{props.intro}</p> : null}
          <div className="mt-4 rounded-brand border border-border border-t-4 border-t-primary bg-white p-4">
            <p className="font-semibold text-navy">Funding consultation</p>
            {props.showDuration ? <p className="mt-1 text-sm text-muted">30 min · Microsoft Teams meeting</p> : <p className="mt-1 text-sm text-muted">Microsoft Teams meeting</p>}
            {props.showDescription ? <p className="mt-2 text-sm text-ink/80">A short call to review your business funding options.</p> : null}
            <span className="mt-3 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground">Choose a time</span>
          </div>
        </div>
      </div>
    </figure>
  );
}
