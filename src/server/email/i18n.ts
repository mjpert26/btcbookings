import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";

/**
 * Message lookup for emails, which render outside a request (job worker), so the
 * next-intl request config does not apply. Catalogs are the same messages/*.json files
 * the public pages use. Placeholders use the {name} syntax.
 */
const CATALOGS: Record<Locale, unknown> = { en, es };

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function translator(locale: string, namespace = ""): Translate {
  const loc: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return (key, vars) => {
    const full = namespace ? `${namespace}.${key}` : key;
    const template = lookup(CATALOGS[loc], full) ?? lookup(CATALOGS[DEFAULT_LOCALE], full) ?? full;
    return template.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
  };
}
