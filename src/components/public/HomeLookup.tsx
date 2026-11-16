"use client";

import { useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Turnstile, type TurnstileHandle } from "./Turnstile";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ErrorKey = "required" | "invalid_email" | "rateLimited" | "verification" | "generic";

/**
 * "Already applied or already a customer?" form on the home page. Posts the email to
 * /api/public/lookup and opens the booking page it answers with. When the answer has no page,
 * shows a fallback with a link to the company website.
 */
export function HomeLookup(props: { turnstileSiteKey: string | null; websiteUrl: string }) {
  const t = useTranslations("home");
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<ErrorKey | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "redirecting" | "fallback">("idle");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const fallbackHeading = useRef<HTMLHeadingElement>(null);

  function fail(key: ErrorKey) {
    setError(key);
    setStatus("idle");
    requestAnimationFrame(() => input.current?.focus());
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (status === "submitting" || status === "redirecting") return;
    const value = email.trim();
    if (!value) return fail("required");
    if (value.length > 254 || !EMAIL_RE.test(value)) return fail("invalid_email");
    setError(null);
    setStatus("submitting");
    try {
      const res = await fetch("/api/public/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value, turnstileToken, lang: locale }),
      });
      const body = (await res.json().catch(() => ({}))) as { next?: string | null; error?: string };
      turnstile.current?.reset();
      if (res.ok && "next" in body) {
        // Only same-site relative paths are followed.
        if (typeof body.next === "string" && body.next.startsWith("/") && !body.next.startsWith("//")) {
          setStatus("redirecting");
          router.push(body.next);
          return;
        }
        setStatus("fallback");
        requestAnimationFrame(() => fallbackHeading.current?.focus());
        return;
      }
      if (body.error === "rate_limited") fail("rateLimited");
      else if (body.error === "verification_failed") fail("verification");
      else if (body.error === "invalid") fail("invalid_email");
      else fail("generic");
    } catch {
      turnstile.current?.reset();
      fail("generic");
    }
  }

  const busy = status === "submitting" || status === "redirecting";
  const site = props.websiteUrl.replace(/^https?:\/\/(www\.)?/, "");

  return (
    <div>
      <form onSubmit={onSubmit} noValidate aria-describedby="home-lookup-privacy" className="space-y-3">
        <label htmlFor="home-email" className="block text-sm font-semibold text-white">
          {t("emailLabel")}
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            ref={input}
            id="home-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            maxLength={254}
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder={t("emailPlaceholder")}
            aria-invalid={error === "required" || error === "invalid_email" ? true : undefined}
            aria-describedby={error ? "home-email-error" : undefined}
            className="h-12 w-full min-w-0 rounded-xl border border-white/40 sm:flex-1 bg-white px-4 text-base text-ink shadow-sm placeholder:text-muted/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white aria-invalid:border-danger"
          />
          <button
            type="submit"
            aria-disabled={busy || undefined}
            className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-6 text-base font-semibold text-navy shadow-lg shadow-black/20 hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {busy ? <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" /> : null}
            {status === "submitting" ? t("submitting") : status === "redirecting" ? t("redirecting") : t("submit")}
          </button>
        </div>
        {props.turnstileSiteKey ? (
          <Turnstile ref={turnstile} siteKey={props.turnstileSiteKey} action="lookup" language={locale} onToken={setTurnstileToken} />
        ) : null}
        <div aria-live="assertive" className="min-h-5">
          {error ? (
            <p id="home-email-error" role="alert" className="rounded-lg bg-white/95 px-3 py-2 text-sm font-medium text-danger">
              {t(`errors.${error}`)}
            </p>
          ) : null}
        </div>
        <p className="sr-only" aria-live="polite">
          {status === "submitting" ? t("submitting") : status === "redirecting" ? t("redirecting") : ""}
        </p>
        <p id="home-lookup-privacy" className="text-xs text-white/75">
          {t("privacy")}
        </p>
      </form>
      {status === "fallback" ? (
        <div className="mt-4 rounded-xl bg-white/95 p-4 text-ink" role="status">
          <h3 ref={fallbackHeading} tabIndex={-1} className="font-heading text-base font-bold text-navy focus:outline-none">
            {t("fallbackTitle")}
          </h3>
          <p className="mt-1 text-sm text-muted">{t("fallbackBody")}</p>
          <a href={props.websiteUrl} rel="noopener" className="mt-3 inline-block text-sm font-semibold text-primary underline">
            {t("visitWebsite", { site })}
          </a>
        </div>
      ) : null}
    </div>
  );
}

/** Switches the home page between English and Spanish with the btc_locale cookie (src/i18n/request.ts). */
export function HomeLanguageSwitch() {
  const t = useTranslations("home");
  const locale = useLocale();
  const router = useRouter();
  const next = locale === "es" ? "en" : "es";
  return (
    <button
      type="button"
      lang={next}
      onClick={() => {
        document.cookie = `btc_locale=${next}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
      className="whitespace-nowrap rounded-lg border border-white/25 px-3 py-1.5 text-sm font-medium text-white/90 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      <span className="sr-only" lang={locale}>{`${t("languageLabel")}: `}</span>
      {t("switchTo")}
    </button>
  );
}
