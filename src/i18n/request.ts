import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";

/**
 * Locale resolution for pages that do not set one explicitly. Public booking pages pass
 * the event type variant's language, so a Spanish variant always renders in Spanish.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  let locale: Locale = DEFAULT_LOCALE;
  const requested = await requestLocale;
  if (isLocale(requested)) {
    locale = requested;
  } else {
    const fromCookie = (await cookies()).get("btc_locale")?.value;
    if (isLocale(fromCookie)) locale = fromCookie;
    else {
      const accept = (await headers()).get("accept-language") ?? "";
      if (/^es\b/i.test(accept)) locale = "es";
    }
  }
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
