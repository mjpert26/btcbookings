import Image from "next/image";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import { LOCALE_LABELS, type Locale } from "@/i18n/locales";
import { brand } from "@/theme/brand";

const CATALOGS = { en, es } as const;

/** Only the namespaces the public client islands use are sent to the browser. */
function clientMessages(locale: Locale) {
  const c = CATALOGS[locale];
  return { common: c.common, public: c.public, booking: c.booking };
}

/**
 * Frame for every public page: locale provider, lang attribute, brand header and footer.
 * The variant's language decides the locale (not the browser's).
 */
export async function PublicShell(props: {
  locale: Locale;
  children: ReactNode;
  alternates?: { language: Locale; path: string }[];
}) {
  const t = await getTranslations({ locale: props.locale, namespace: "public" });
  const tc = await getTranslations({ locale: props.locale, namespace: "common" });
  return (
    <NextIntlClientProvider locale={props.locale} messages={clientMessages(props.locale)}>
      <div lang={props.locale} className="flex min-h-full flex-1 flex-col">
        <header className="border-b border-border bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <a href={brand.websiteUrl} className="inline-flex shrink-0 items-center" rel="noopener">
              <Image src={brand.logo.light.src} alt={brand.logo.alt} width={120} height={50} priority className="h-9 w-auto" />
            </a>
            {props.alternates?.length ? (
              <nav aria-label={t("languageSwitcher")} className="flex items-center gap-1 text-sm">
                <span className="rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary" aria-current="page">
                  {LOCALE_LABELS[props.locale]}
                </span>
                {props.alternates.map((a) => (
                  <Link
                    key={a.language}
                    href={a.path}
                    hrefLang={a.language}
                    lang={a.language}
                    className="rounded-full px-3 py-1.5 font-medium text-primary hover:bg-surface-alt"
                  >
                    {LOCALE_LABELS[a.language]}
                  </Link>
                ))}
              </nav>
            ) : null}
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
          {props.children}
        </main>
        <footer className="px-4 pb-8 text-center text-xs text-muted">{tc("poweredBy")}</footer>
      </div>
    </NextIntlClientProvider>
  );
}
