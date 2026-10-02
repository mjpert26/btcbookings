"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { SlotPicker, type ClientSlot } from "./SlotPicker";
import { Turnstile, type TurnstileHandle } from "./Turnstile";
import { useDetectedTimezone } from "./BookingFlow";
import { formatDateTime } from "./time";

type Props = {
  token: string;
  status: "confirmed" | "cancelled" | "rescheduled";
  canCancel: boolean;
  canReschedule: boolean;
  isNew: boolean;
  locationIsTeams: boolean;
  onlineMeetingUrl: string | null;
  inviteeTimezone: string;
  durationMin: number;
  windowEnd: string | null;
  turnstileSiteKey: string | null;
  links: { ics: string; google: string; outlook: string } | null;
};

async function manage(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch("/api/public/manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Teams link polling, calendar links, and the cancel and reschedule actions on /b/[token]. */
export function ManageBooking(props: Props) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const router = useRouter();
  const detected = useDetectedTimezone();
  const [zone, setZone] = useState<string | null>(null);
  const timezone = zone ?? detected ?? props.inviteeTimezone;
  const [mode, setMode] = useState<"view" | "cancel" | "reschedule">("view");
  const [meetingUrl, setMeetingUrl] = useState(props.onlineMeetingUrl);
  const [pollDone, setPollDone] = useState(!props.isNew || !props.locationIsTeams || !!props.onlineMeetingUrl || props.status !== "confirmed");
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<ClientSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);

  // The Outlook event (and its Teams link) is created by a background job right after
  // booking. Poll briefly; otherwise the link arrives in the confirmation email.
  useEffect(() => {
    if (pollDone) return;
    let tries = 0;
    let stopped = false;
    const tick = async () => {
      tries++;
      const r = await manage({ action: "status", token: props.token }).catch(() => null);
      if (stopped) return;
      const url = r?.ok ? (r.data.onlineMeetingUrl as string | null) : null;
      if (url) {
        setMeetingUrl(url);
        setPollDone(true);
      } else if (tries >= 5) setPollDone(true);
      else timer = setTimeout(tick, 1000);
    };
    let timer = setTimeout(tick, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollDone, props.token]);

  const loadSlots = useCallback(
    async (from: string, to: string) => {
      const r = await manage({ action: "slots", token: props.token, from, to });
      if (!r.ok) throw new Error(String(r.status));
      return r.data.slots as ClientSlot[];
    },
    [props.token],
  );

  function failure(code: unknown) {
    turnstile.current?.reset();
    if (code === "slot_taken") setError(t("errors.slotTaken"));
    else if (code === "rate_limited") setError(t("errors.rateLimited"));
    else if (code === "verification_failed") setError(t("errors.verification"));
    else setError(t("errors.generic"));
  }

  async function doCancel() {
    setBusy(true);
    setError(null);
    const r = await manage({ action: "cancel", token: props.token, reason: reason.trim() || undefined, turnstileToken }).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      setMode("view");
      router.refresh();
    } else failure(r?.data.error);
  }

  async function doReschedule() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const r = await manage({ action: "reschedule", token: props.token, start: picked.start, timezone, turnstileToken }).catch(() => null);
    setBusy(false);
    if (r?.ok && typeof r.data.token === "string") {
      router.replace(`/b/${r.data.token}?updated=1`);
    } else {
      failure(r?.data.error);
      if (r?.data.error === "slot_taken") setPicked(null);
    }
  }

  const needsTurnstile = !!props.turnstileSiteKey;
  const turnstileBox = needsTurnstile ? (
    <Turnstile ref={turnstile} siteKey={props.turnstileSiteKey!} language={locale} onToken={setTurnstileToken} />
  ) : null;
  const errorBox = error ? (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      {error}
    </div>
  ) : null;
  const primaryBtn =
    "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";
  const dangerBtn =
    "inline-flex min-h-11 items-center justify-center rounded-lg bg-danger px-5 text-sm font-semibold text-white hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60";
  const secondaryBtn =
    "inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-white px-5 text-sm font-semibold text-primary hover:border-primary";

  if (mode === "cancel") {
    return (
      <section aria-labelledby="cancel-heading" className="flex flex-col gap-4">
        <h2 id="cancel-heading" className="text-lg font-semibold">
          {t("manage.cancelHeading")}
        </h2>
        <div>
          <label htmlFor="cancel-reason" className="mb-1 block text-sm font-medium">
            {t("manage.cancelReason")} <span className="font-normal text-muted">({t("optional")})</span>
          </label>
          <textarea
            id="cancel-reason"
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-border px-3 py-2"
          />
        </div>
        {turnstileBox}
        {errorBox}
        <div className="flex flex-wrap gap-3">
          <button type="button" className={dangerBtn} disabled={busy} onClick={doCancel}>
            {busy ? t("manage.cancelling") : t("manage.cancelConfirm")}
          </button>
          <button type="button" className={secondaryBtn} onClick={() => setMode("view")}>
            {t("manage.keep")}
          </button>
        </div>
      </section>
    );
  }

  if (mode === "reschedule" && props.windowEnd) {
    return (
      <section aria-labelledby="reschedule-heading" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="reschedule-heading" className="text-lg font-semibold">
            {t("manage.rescheduleHeading")}
          </h2>
          <button type="button" className="text-sm font-medium text-primary underline" onClick={() => { setMode("view"); setPicked(null); }}>
            {t("manage.back")}
          </button>
        </div>
        {picked ? (
          <div className="flex flex-col gap-4">
            <p className="rounded-brand border border-border bg-surface-alt p-4 text-sm font-semibold text-navy">
              {t("manage.newTime", { time: formatDateTime(Date.parse(picked.start), timezone, locale) })}
            </p>
            {turnstileBox}
            {errorBox}
            <div className="flex flex-wrap gap-3">
              <button type="button" className={primaryBtn} disabled={busy} onClick={doReschedule}>
                {busy ? t("manage.rescheduling") : t("manage.rescheduleConfirm")}
              </button>
              <button type="button" className={secondaryBtn} onClick={() => setPicked(null)}>
                {t("changeTime")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {errorBox}
            <SlotPicker
              durations={[props.durationMin]}
              duration={props.durationMin}
              timezone={timezone}
              onTimezoneChange={setZone}
              windowEnd={props.windowEnd}
              loadSlots={loadSlots}
              onPick={(s) => {
                setError(null);
                setPicked(s);
              }}
            />
          </>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {props.status === "confirmed" && props.locationIsTeams ? (
        <div aria-live="polite" className="text-sm">
          {meetingUrl ? (
            <a href={meetingUrl} rel="noopener noreferrer" target="_blank" className={primaryBtn}>
              {t("confirm.joinTeams")}
            </a>
          ) : !pollDone ? (
            <p className="text-muted">{t("confirm.teamsLoading")}</p>
          ) : (
            <p className="text-muted">{t("confirm.teamsPending")}</p>
          )}
        </div>
      ) : null}
      {props.links && props.status === "confirmed" ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{t("confirm.addToCalendar")}</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            <li>
              <a href={props.links.ics} className={secondaryBtn} download>
                {t("confirm.downloadIcs")}
              </a>
            </li>
            <li>
              <a href={props.links.google} className={secondaryBtn} target="_blank" rel="noopener noreferrer">
                {t("confirm.googleCalendar")}
              </a>
            </li>
            <li>
              <a href={props.links.outlook} className={secondaryBtn} target="_blank" rel="noopener noreferrer">
                {t("confirm.outlookCalendar")}
              </a>
            </li>
          </ul>
        </div>
      ) : null}
      {props.canCancel || props.canReschedule ? (
        <div className="flex flex-wrap gap-3 border-t border-border pt-5">
          {props.canReschedule ? (
            <button type="button" className={secondaryBtn} onClick={() => { setError(null); setMode("reschedule"); }}>
              {t("confirm.reschedule")}
            </button>
          ) : null}
          {props.canCancel ? (
            <button type="button" className={`${secondaryBtn} text-danger hover:border-danger`} onClick={() => { setError(null); setMode("cancel"); }}>
              {t("confirm.cancel")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
