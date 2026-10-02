import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { service } from "@/server/db/client";
import { env } from "@/server/env";
import { isLocale, type Locale } from "@/i18n/locales";
import { listPublicEventTypes, loadPublicEventType, toPublicEventType } from "@/server/booking/load";
import { slugSchema } from "@/server/booking/validation";
import type { OwnerRef } from "@/server/booking/types";
import { PublicShell } from "./PublicShell";
import { BookingFlow } from "./BookingFlow";
import { Avatar, Card, IconClock, IconLocation } from "./bits";

/** Server-rendered public pages. Each loads only public-safe data (see server/booking/load). */

function validRef(kind: "user" | "team", slug: string): OwnerRef | null {
  return slugSchema.safeParse(slug).success ? { kind, slug } : null;
}

const loadEvent = cache(async function loadEvent(kind: "user" | "team", ownerSlug: string, eventSlug: string, language: Locale) {
  const ref = validRef(kind, ownerSlug);
  if (!ref || !slugSchema.safeParse(eventSlug).success) return null;
  const db = service();
  const loaded = await loadPublicEventType(db, ref, eventSlug, language);
  if (!loaded) return null;
  const windowEnd = new Date(Date.now() + (loaded.resolved.eventType.booking_window_days + 1) * 86_400_000).toISOString();
  return { loaded, windowEnd, event: await toPublicEventType(db, loaded) };
});

export async function eventMetadata(kind: "user" | "team", ownerSlug: string, eventSlug: string, language: Locale): Promise<Metadata> {
  const found = await loadEvent(kind, ownerSlug, eventSlug, language);
  if (!found) return { title: "404" };
  const who = found.event.host?.name ?? found.event.team?.name ?? "";
  return { title: who ? `${found.event.name} · ${who}` : found.event.name };
}

function durationText(durations: number[], minutes: (n: number) => string): string {
  return durations.map(minutes).join(" / ");
}

export async function EventBookingPage(props: { kind: "user" | "team"; ownerSlug: string; eventSlug: string; language: Locale }) {
  const found = await loadEvent(props.kind, props.ownerSlug, props.eventSlug, props.language);
  if (!found) notFound();
  const { event, windowEnd } = found;
  const t = await getTranslations({ locale: event.language, namespace: "public" });
  const siteKey = env().TURNSTILE_SITE_KEY || null;

  return (
    <PublicShell locale={event.language} alternates={event.alternates}>
      <Card className="overflow-hidden md:grid md:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-surface-alt/60 p-5 sm:p-6 md:border-b-0 md:border-r">
          {event.host ? (
            <div className="mb-4 flex items-center gap-3">
              <Avatar name={event.host.name} photoUrl={event.host.photoUrl} size={52} alt={t("hostPhotoAlt", { name: event.host.name })} />
              <p className="text-sm font-medium text-muted">{event.host.name}</p>
            </div>
          ) : event.team ? (
            <p className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">{t("teamMeeting", { team: event.team.name })}</p>
          ) : null}
          <h1 className="text-2xl font-bold leading-tight">{event.name}</h1>
          <ul className="mt-4 flex flex-col gap-2 text-sm text-ink">
            <li className="flex items-center gap-2">
              <IconClock />
              {durationText(event.durations, (n) => t("minutes", { count: n }))}
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5">
                <IconLocation type={event.locationType} />
              </span>
              <span>
                {t(`location.${event.locationType}`)}
                {event.locationDetail ? <span className="block text-muted">{event.locationDetail}</span> : null}
              </span>
            </li>
          </ul>
          {event.description ? <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-muted">{event.description}</p> : null}
        </aside>
        <div className="p-5 sm:p-6">
          <BookingFlow event={event} windowEnd={windowEnd} turnstileSiteKey={siteKey} />
        </div>
      </Card>
    </PublicShell>
  );
}

export async function OwnerListingPage(props: { kind: "user" | "team"; ownerSlug: string; lang?: string | string[] }) {
  const ref = validRef(props.kind, props.ownerSlug);
  if (!ref) notFound();
  const language: Locale = typeof props.lang === "string" && isLocale(props.lang) ? props.lang : "en";
  const listing = await listPublicEventTypes(service(), ref, language);
  if (!listing) notFound();
  const t = await getTranslations({ locale: language, namespace: "public" });
  const owner = listing.owner;
  const other: Locale = language === "en" ? "es" : "en";
  const hasOther = listing.languages.includes(other);
  const base = props.kind === "user" ? `/${owner.slug}` : `/t/${owner.slug}`;

  return (
    <PublicShell locale={language} alternates={hasOther ? [{ language: other, path: other === "en" ? base : `${base}?lang=${other}` }] : []}>
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex flex-col items-center text-center">
          {owner.kind === "user" ? (
            <Avatar name={owner.name} photoUrl={owner.photoUrl} size={80} alt={t("hostPhotoAlt", { name: owner.name })} />
          ) : null}
          <h1 className="mt-3 text-2xl font-bold">{owner.name}</h1>
          {owner.kind === "team" && owner.description ? <p className="mt-2 max-w-xl text-muted">{owner.description}</p> : null}
          <p className="mt-4 text-sm font-semibold uppercase tracking-wide text-muted">{t("eventsHeading")}</p>
        </div>
        {listing.events.length ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {listing.events.map((e) => (
              <li key={e.path}>
                <Link
                  href={e.path}
                  lang={e.language}
                  className="group block h-full rounded-brand border border-border border-t-4 border-t-primary bg-white p-5 transition-shadow hover:shadow-md"
                >
                  <h2 className="text-lg font-semibold group-hover:text-primary">{e.name}</h2>
                  <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <IconClock />
                      {durationText(e.durations, (n) => t("minutes", { count: n }))}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <IconLocation type={e.locationType} />
                      {t(`location.${e.locationType}`)}
                    </span>
                  </p>
                  {e.description ? <p className="mt-3 line-clamp-3 text-sm text-ink/80">{e.description}</p> : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Card className="p-8 text-center text-muted">{t("noEvents")}</Card>
        )}
      </div>
    </PublicShell>
  );
}

/** Same page for every unknown or inactive address, so nothing can be enumerated. */
export async function PublicNotFound() {
  const t = await getTranslations({ locale: "en", namespace: "public" });
  return (
    <PublicShell locale="en">
      <Card className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-2xl font-bold">{t("notFoundTitle")}</h1>
        <p className="mt-2 text-muted">{t("notFoundBody")}</p>
        <div lang="es" className="mt-6 border-t border-border pt-6">
          <p className="text-lg font-semibold text-navy">{t("notFoundAltTitle")}</p>
          <p className="mt-1 text-muted">{t("notFoundAltBody")}</p>
        </div>
      </Card>
    </PublicShell>
  );
}
