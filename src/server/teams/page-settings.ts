import { z } from "zod";
import { brand } from "@/theme/brand";

/**
 * Display settings for a partner's (team's) public booking pages, stored in
 * app.teams.page_settings. This module is pure (no database, no server-only imports) so the
 * branding form can reuse the schema and the contrast check for its live preview.
 */

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Plain text only: no control characters other than line breaks and tabs. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const plainText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} cannot be empty.`)
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((v) => !CONTROL_CHARS.test(v), `${label} contains characters that are not allowed.`);

export const pageSettingsSchema = z
  .object({
    displayName: plainText(80, "Display name").refine((v) => !/[\r\n]/.test(v), "Display name must be a single line.").optional(),
    accentColor: z.string().regex(HEX_COLOR, "Use a hex color like #0D66A5.").transform((v) => v.toUpperCase()).optional(),
    heading: plainText(120, "Heading").refine((v) => !/[\r\n]/.test(v), "Heading must be a single line.").optional(),
    intro: plainText(1000, "Intro").optional(),
    showHostPhoto: z.boolean().optional(),
    showHostName: z.boolean().optional(),
    showBtcLogo: z.boolean().optional(),
    showDuration: z.boolean().optional(),
    showDescription: z.boolean().optional(),
    showPartnerLogo: z.boolean().optional(),
  })
  .strict();

export type PageSettingsInput = z.input<typeof pageSettingsSchema>;
export type StoredPageSettings = z.output<typeof pageSettingsSchema>;

/** Settings with every default applied. Text fields are null when not set. */
export type PageSettings = {
  displayName: string | null;
  accentColor: string | null;
  heading: string | null;
  intro: string | null;
  showHostPhoto: boolean;
  showHostName: boolean;
  showBtcLogo: boolean;
  showDuration: boolean;
  showDescription: boolean;
  showPartnerLogo: boolean;
};

export const DEFAULT_PAGE_SETTINGS: PageSettings = {
  displayName: null,
  accentColor: null,
  heading: null,
  intro: null,
  showHostPhoto: true,
  showHostName: true,
  showBtcLogo: true,
  showDuration: true,
  showDescription: true,
  showPartnerLogo: true,
};

export const PAGE_SETTING_TOGGLES = [
  "showPartnerLogo",
  "showBtcLogo",
  "showHostPhoto",
  "showHostName",
  "showDuration",
  "showDescription",
] as const satisfies readonly (keyof PageSettings)[];

/** Validates new settings. Throws a ZodError for unknown keys or invalid values. */
export function parsePageSettings(input: unknown): StoredPageSettings {
  return pageSettingsSchema.parse(input);
}

/**
 * Reads stored settings leniently: valid fields are kept and invalid or unknown ones fall
 * back to their defaults, so one bad value never breaks a public page.
 */
export function resolvePageSettings(raw: unknown): PageSettings {
  const out: PageSettings = { ...DEFAULT_PAGE_SETTINGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const shape = pageSettingsSchema.shape;
  for (const key of Object.keys(DEFAULT_PAGE_SETTINGS) as (keyof PageSettings)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = shape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined) (out as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

/** The stored form of complete settings: text fields that are not set are omitted. */
export function toStoredPageSettings(s: PageSettings): StoredPageSettings {
  const out: StoredPageSettings = {};
  if (s.displayName) out.displayName = s.displayName;
  if (s.accentColor) out.accentColor = s.accentColor;
  if (s.heading) out.heading = s.heading;
  if (s.intro) out.intro = s.intro;
  for (const key of PAGE_SETTING_TOGGLES) out[key] = s[key];
  return out;
}

// ---------------------------------------------------------------------------
// Color contrast (WCAG 2.x)
// ---------------------------------------------------------------------------

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Minimum contrast for normal-size text (WCAG AA). */
export const MIN_TEXT_CONTRAST = 4.5;

export type AccentResult = {
  /** The color public pages use: the requested accent, or the BTC brand color. */
  color: string;
  /** A darker shade of `color` for hover states. */
  hover: string;
  /** True when an accent was requested but replaced because its contrast is too low. */
  fellBack: boolean;
  /** Contrast of the requested accent against white, when one was requested. */
  ratio: number | null;
};

function darken(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex).map((c) => Math.max(0, Math.round(c * (1 - amount))));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
}

/**
 * The accent color for public pages. The accent is used for white button text and for text
 * and links on white, so it must reach 4.5:1 against white; otherwise the brand color is used.
 */
export function accessibleAccent(requested: string | null | undefined): AccentResult {
  const fallback = { color: brand.colors.primary, hover: brand.colors.primaryHover };
  if (!requested || !HEX_COLOR.test(requested)) return { ...fallback, fellBack: false, ratio: null };
  const ratio = contrastRatio(requested, "#FFFFFF");
  if (ratio < MIN_TEXT_CONTRAST) return { ...fallback, fellBack: true, ratio };
  const color = requested.toUpperCase();
  return { color, hover: darken(color, 0.12), fellBack: false, ratio };
}
