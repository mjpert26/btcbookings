import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { env } from "@/server/env";
import { getBookingByToken } from "@/server/booking/manage";
import { googleCalendarUrl, outlookCalendarUrl } from "@/server/booking/ics";
import { formatWhen } from "@/server/email/format";
import { PublicShell } from "./PublicShell";
import { ManageBooking } from "./ManageBooking";
import { Avatar, Card, IconClock, IconLocation } from "./bits";

/** /b/[token]: confirmation, status and self-service for one booking. */
export async function BookingPage(props: { token: string; isNew: boolean; updated: boolean }) {
  const view = await getBookingByToken(props.token);
  if (!view) notFound();
  const locale = view.language;
  const t = await getTranslations({ locale, namespace: "booking" });
  const tp = await getTranslations({ locale, namespace: "public" });
  const tm = await getTranslations({ locale, namespace: "booking.manage" });
  const start = new Date(view.start);
  const end = new Date(view.end);
  const when = formatWhen(start, end, view.inviteeTimezone, locale);

  const state =
    view.status === "cancelled"
      ? { title: t("confirm.cancelledTitle"), body: t("confirm.cancelledBody"), tone: "muted" }
      : view.status === "rescheduled"
        ? { title: t("confirm.rescheduledTitle"), body: t("confirm.rescheduledBody"), tone: "muted" }
        : view.isPast
          ? { title: t("confirm.pastTitle"), body: t("confirm.pastBody"), tone: "muted" }
          : props.isNew
            ? { title: t("confirm.bookedTitle"), body: t("confirm.bookedBody"), tone: "success" }
            : props.updated
              ? { title: t("confirm.viewTitle"), body: tm("rescheduledDone"), tone: "success" }
              : { title: t("confirm.viewTitle"), body: null, tone: "plain" };

  const where = tp(`location.${view.locationType}`);
  const calendarInput = {
    title: view.eventName,
    start,
    end,
    location: view.locationType === "teams" ? view.onlineMeetingUrl ?? where : [where, view.locationDetail].filter(Boolean).join(": "),
    description: view.hosts.map((h) => h.name).join(", "),
  };
  const live = view.status === "confirmed" && !view.isPast;

  return (
    <PublicShell locale={locale}>
      <Card className="mx-auto max-w-2xl p-6 sm:p-8">
        <div className="mb-6 flex items-start gap-3">
          {state.tone === "success" ? (
            <span aria-hidden="true" className="btc-check-circle relative mt-0.5 inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-success text-white shadow-lg shadow-success/30">
              <span className="absolute inset-0 animate-ping rounded-full bg-success/30 [animation-iteration-count:2] motion-reduce:hidden" />
              <svg viewBox="0 0 24 24" className="relative size-6" fill="none" stroke="currentColor" strokeWidth="2.6">
                <path className="btc-check-path" d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          ) : null}
          <div>
            <h1 className="text-2xl font-bold">{state.title}</h1>
            {state.body ? <p className="mt-1 text-muted">{state.body}</p> : null}
          </div>
        </div>

        <div className="rounded-brand border border-border bg-surface-alt/60 p-5">
        <h2 className={`mb-4 text-lg font-semibold text-navy ${view.status === "cancelled" ? "line-through" : ""}`}>{view.eventName}</h2>
        <dl className="grid gap-4">
          <div className="flex gap-3">
            <dt className="mt-0.5 text-muted">
              <IconClock />
              <span className="sr-only">{t("confirm.when")}</span>
            </dt>
            <dd>
              <p className="font-medium">{when.date}</p>
              <p>{when.range}</p>
              <p className="text-sm text-muted">{t("confirm.timezone", { tz: `${when.zoneName} (${view.inviteeTimezone.replace(/_/g, " ")})` })}</p>
            </dd>
          </div>
          {view.hosts.length ? (
            <div>
              <dt className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("confirm.with")}</dt>
              <dd>
                <ul className="flex flex-wrap gap-4">
                  {view.hosts.map((h) => (
                    <li key={h.name} className="flex items-center gap-2">
                      <Avatar name={h.name} photoUrl={h.photoUrl} size={40} alt={t("confirm.hostPhotoAlt", { name: h.name })} />
                      <span className="font-medium">{h.name}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          <div className="flex gap-3">
            <dt className="mt-0.5 text-muted">
              <IconLocation type={view.locationType} />
              <span className="sr-only">{t("confirm.where")}</span>
            </dt>
            <dd>
              {where}
              {view.locationDetail ? <span className="block text-muted">{view.locationDetail}</span> : null}
            </dd>
          </div>
        </dl>
        </div>

        <div className="mt-6">
          <ManageBooking
            token={props.token}
            status={view.status}
            canCancel={view.canCancel}
            canReschedule={view.canReschedule}
            isNew={props.isNew}
            locationIsTeams={view.locationType === "teams"}
            onlineMeetingUrl={view.onlineMeetingUrl}
            inviteeTimezone={view.inviteeTimezone}
            durationMin={view.durationMin}
            windowEnd={view.windowEnd}
            turnstileSiteKey={env().TURNSTILE_SITE_KEY || null}
            links={
              live
                ? {
                    ics: `/b/${props.token}/ics`,
                    google: googleCalendarUrl(calendarInput),
                    outlook: outlookCalendarUrl(calendarInput),
                  }
                : null
            }
          />
        </div>

        {!live && view.eventPath ? (
          <p className="mt-6">
            <a href={view.eventPath} className="font-semibold text-primary underline">
              {t("confirm.bookAgain")}
            </a>
          </p>
        ) : null}
      </Card>
    </PublicShell>
  );
}
