/**
 * Supported public locales. Adding a language means adding its code here and a
 * messages/<code>.json catalog; no other code changes are needed.
 */
export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
};

/** BCP 47 tags used for Intl date and time formatting. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  es: "es-US",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Picks a translated string from a {locale: text} map, falling back to English, then any value. */
export function pickLocalized(map: Record<string, string> | null | undefined, locale: string): string {
  if (!map) return "";
  return map[locale] ?? map[DEFAULT_LOCALE] ?? Object.values(map)[0] ?? "";
}
