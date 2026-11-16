import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { brand } from "@/theme/brand";
import { getSessionUser } from "@/server/auth/session";
import { service } from "@/server/db/client";
import { turnstileSiteKey } from "@/server/settings/integrations";
import { newBusinessPath, readHomeRouting, safeRelativePath } from "@/server/home/destination";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";
import AuroraBackground from "@/components/reactbits/AuroraBackground";
import StaggeredText from "@/components/reactbits/StaggeredText";
import { clientMessages } from "@/components/public/PublicShell";
import { HomeLanguageSwitch, HomeLookup } from "@/components/public/HomeLookup";

export const metadata: Metadata = { title: brand.name };
export const dynamic = "force-dynamic";

/** The new-business page in the visitor's language, or null. The home page still renders when this fails. */
async function newHerePath(locale: Locale): Promise<string | null> {
  try {
    const db = service();
    return safeRelativePath(await newBusinessPath(db, await readHomeRouting(db), locale));
  } catch {
    console.warn(JSON.stringify({ msg: "home page could not load the new-business page" }));
    return null;
  }
}

/**
 * Public landing page. Returning applicants and customers enter their email and are sent to
 * their account manager's or renewal team's booking page (src/server/home); new visitors book
 * with the next available advisor. It must not describe internal tooling. Signed-in employees
 * go straight to their dashboard; staff sign in at /login.
 */
export default async function Home() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  const requested = await getLocale();
  const locale: Locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "home" });
  const [siteKey, newPath] = await Promise.all([turnstileSiteKey().catch(() => null), newHerePath(locale)]);

  return (
    <NextIntlClientProvider locale={locale} messages={clientMessages(locale)}>
      <main
        id="main"
        lang={locale}
        className="relative isolate flex min-h-screen flex-1 flex-col overflow-hidden bg-gradient-to-br from-navy via-[#0b4f84] to-primary text-white"
      >
        <div className="absolute inset-0 -z-10">
          <AuroraBackground speed={0.8} brightness={1.25} bloomIntensity={2.2} opacity={0.95} />
        </div>
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,transparent_20%,rgb(6_34_59/0.55)_75%)]" />

        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <span className="flex items-center gap-3">
            <Image src={brand.logo.mark.src} alt="" width={40} height={40} priority className="size-10 rounded-lg bg-white/95 p-1 shadow-md shadow-black/20" />
            <span className="font-heading text-sm font-semibold uppercase tracking-[0.2em] text-white/90 max-sm:sr-only">{brand.name}</span>
          </span>
          <HomeLanguageSwitch />
        </header>

        <section aria-labelledby="home-heading" className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-5 pb-16 sm:px-8">
          <h1 id="home-heading" className="text-center font-heading text-4xl font-extrabold leading-[1.05] text-white sm:text-6xl">
            <StaggeredText key={locale} text={t("title")} as="span" className="block" delay={90} startDelay={150} />
          </h1>
          <p className="btc-fade-up mt-6 max-w-xl text-center text-base text-white/85 [animation-delay:600ms] sm:text-lg">{t("intro")}</p>

          <div className={`btc-fade-up mt-10 grid w-full gap-5 [animation-delay:800ms] ${newPath ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "max-w-2xl"}`}>
            <section aria-labelledby="home-returning" className="rounded-2xl border border-white/20 bg-white/10 p-6 shadow-xl shadow-black/20 backdrop-blur-md sm:p-8">
              <h2 id="home-returning" className="font-heading text-xl font-bold text-white sm:text-2xl">
                {t("returningHeading")}
              </h2>
              <p className="mt-2 text-sm text-white/85 sm:text-base">{t("returningBody")}</p>
              <div className="mt-5">
                <HomeLookup turnstileSiteKey={siteKey} websiteUrl={brand.websiteUrl} />
              </div>
            </section>

            {newPath ? (
              <section aria-labelledby="home-new" className="flex flex-col rounded-2xl border border-white/20 bg-white/10 p-6 shadow-xl shadow-black/20 backdrop-blur-md sm:p-8">
                <h2 id="home-new" className="font-heading text-xl font-bold text-white sm:text-2xl">
                  {t("newHeading")}
                </h2>
                <p className="mt-2 text-sm text-white/85 sm:text-base">{t("newBody")}</p>
                <div className="mt-5 lg:mt-auto lg:pt-5">
                  <Link
                    href={newPath}
                    className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-white/70 px-6 py-3 text-center text-base font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  >
                    {t("newButton")}
                  </Link>
                </div>
              </section>
            ) : null}
          </div>
        </section>

        <footer className="pb-6 text-center text-xs text-white/60">
          © {new Date().getFullYear()} {brand.name}
        </footer>
      </main>
    </NextIntlClientProvider>
  );
}
