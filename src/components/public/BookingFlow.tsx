"use client";

import { useCallback, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { PublicEventType } from "@/server/booking/types";
import { SlotPicker, type ClientSlot } from "./SlotPicker";
import { Turnstile, type TurnstileHandle } from "./Turnstile";
import { detectTimezone, formatDateTime, formatTime } from "./time";

const noop = () => () => {};

/** The invitee's zone, read only in the browser (null during server rendering). */
export function useDetectedTimezone(): string | null {
  return useSyncExternalStore(noop, () => detectTimezone(), () => null);
}

type Props = {
  event: Pick<PublicEventType, "ownerKind" | "ownerSlug" | "eventSlug" | "language" | "durations" | "defaultDuration" | "questions">;
  windowEnd: string;
  turnstileSiteKey: string | null;
};

type FieldErrors = Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function BookingFlow({ event, windowEnd, turnstileSiteKey }: Props) {
  const detected = useDetectedTimezone();
  const [chosenZone, setZone] = useState<string | null>(null);
  const timezone = chosenZone ?? detected;
  const [duration, setDuration] = useState(event.defaultDuration);
  const [slot, setSlot] = useState<ClientSlot | null>(null);
  const ref = `${event.ownerKind}:${event.ownerSlug}`;

  const loadSlots = useCallback(
    async (from: string, to: string, d: number) => {
      const q = new URLSearchParams({ ref, event: event.eventSlug, lang: event.language, from, to, duration: String(d) });
      const res = await fetch(`/api/public/slots?${q.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as { slots: ClientSlot[] }).slots;
    },
    [ref, event.eventSlug, event.language],
  );

  if (!timezone) {
    return <div className="h-96 animate-pulse rounded-brand bg-surface-alt" aria-hidden="true" />;
  }

  if (slot) {
    return (
      <IntakeForm
        event={event}
        slot={slot}
        duration={duration}
        timezone={timezone}
        turnstileSiteKey={turnstileSiteKey}
        onBack={() => setSlot(null)}
      />
    );
  }

  return (
    <SlotPicker
      durations={event.durations}
      duration={duration}
      onDurationChange={setDuration}
      timezone={timezone}
      onTimezoneChange={setZone}
      windowEnd={windowEnd}
      loadSlots={loadSlots}
      onPick={setSlot}
    />
  );
}

function IntakeForm(props: {
  event: Props["event"];
  slot: ClientSlot;
  duration: number;
  timezone: string;
  turnstileSiteKey: string | null;
  onBack: () => void;
}) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const router = useRouter();
  const { event, slot, timezone } = props;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const [idempotencyKey] = useState(newKey);
  const summaryRef = useRef<HTMLDivElement>(null);

  const phoneQuestion = event.questions.find((q) => q.key === "phone");
  const phoneRequired = !!phoneQuestion?.required;
  const otherQuestions = event.questions.filter((q) => q.key !== "phone");

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!name.trim()) e.name = "required";
    if (!email.trim()) e.email = "required";
    else if (!EMAIL_RE.test(email.trim())) e.email = "invalid_email";
    if (phoneRequired && !phone.trim()) e.phone = "required";
    for (const q of otherQuestions) {
      const v = answers[q.key];
      if (q.required && (q.type === "checkbox" ? v !== true : !String(v ?? "").trim())) e[q.key] = "required";
      if (q.type === "email" && typeof v === "string" && v.trim() && !EMAIL_RE.test(v.trim())) e[q.key] = "invalid_email";
    }
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    const local = validate();
    setErrors(local);
    if (Object.keys(local).length) {
      setFormError(t("errors.fixBelow"));
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/public/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref: `${event.ownerKind}:${event.ownerSlug}`,
          event: event.eventSlug,
          lang: event.language,
          start: slot.start,
          duration: props.duration,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
          timezone,
          answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== "")),
          idempotencyKey,
          turnstileToken,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string; fields?: FieldErrors };
      if (res.ok && body.token) {
        router.push(`/b/${body.token}?new=1`);
        return;
      }
      turnstile.current?.reset();
      if (body.error === "invalid" && body.fields) {
        const fields: FieldErrors = {};
        for (const [k, v] of Object.entries(body.fields)) fields[k.replace(/^answers\./, "")] = v;
        setErrors(fields);
        setFormError(t("errors.fixBelow"));
      } else if (body.error === "slot_taken") setFormError(t("errors.slotTaken"));
      else if (body.error === "rate_limited") setFormError(t("errors.rateLimited"));
      else if (body.error === "verification_failed") setFormError(t("errors.verification"));
      else setFormError(t("errors.generic"));
      requestAnimationFrame(() => summaryRef.current?.focus());
    } catch {
      turnstile.current?.reset();
      setFormError(t("errors.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  const errorText = (key: string) => (errors[key] ? t.has(`errors.${errors[key]}`) ? t(`errors.${errors[key]}`) : t("errors.invalid") : null);
  const slotTaken = formError === t("errors.slotTaken");

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-brand border border-border bg-surface-alt p-4">
        <div>
          <p className="text-sm font-semibold text-navy">{formatDateTime(Date.parse(slot.start), timezone, locale)}</p>
          <p className="text-sm text-muted">
            {formatTime(Date.parse(slot.start), timezone, locale)} – {formatTime(Date.parse(slot.end), timezone, locale)} ·{" "}
            {timezone.replace(/_/g, " ")}
          </p>
        </div>
        <button type="button" onClick={props.onBack} className="text-sm font-medium text-primary underline">
          {t("changeTime")}
        </button>
      </div>

      <h2 className="mb-4 text-lg font-semibold">{t("detailsHeading")}</h2>
      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        {formError ? (
          <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            {formError}
            {slotTaken ? (
              <>
                {" "}
                <button type="button" className="font-semibold underline" onClick={props.onBack}>
                  {t("changeTime")}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="f-name" label={t("name")} error={errorText("name")}>
          <input id="f-name" name="name" autoComplete="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} {...aria("f-name", errors.name)} className={inputClass(errors.name)} />
        </Field>
        <Field id="f-email" label={t("email")} error={errorText("email")}>
          <input id="f-email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} {...aria("f-email", errors.email)} className={inputClass(errors.email)} />
        </Field>
        <Field id="f-phone" label={phoneQuestion?.label || t("phone")} optional={!phoneRequired ? t("optional") : undefined} error={errorText("phone")}>
          <input id="f-phone" name="phone" type="tel" autoComplete="tel" required={phoneRequired} maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} {...aria("f-phone", errors.phone)} className={inputClass(errors.phone)} />
        </Field>
        {otherQuestions.map((q) => {
          const id = `f-q-${q.key}`;
          const value = answers[q.key];
          const set = (v: string | boolean) => setAnswers((a) => ({ ...a, [q.key]: v }));
          if (q.type === "checkbox") {
            return (
              <div key={q.key}>
                <label htmlFor={id} className="flex items-start gap-3 text-sm text-ink">
                  <input id={id} type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} {...aria(id, errors[q.key])} className="mt-0.5 h-5 w-5 rounded border-border accent-[var(--btc-primary)]" />
                  <span>
                    {q.label}
                    {!q.required ? <span className="text-muted"> ({t("optional")})</span> : null}
                  </span>
                </label>
                {errorText(q.key) ? <p id={`${id}-error`} className="mt-1 text-sm text-danger">{errorText(q.key)}</p> : null}
              </div>
            );
          }
          return (
            <Field key={q.key} id={id} label={q.label} optional={!q.required ? t("optional") : undefined} error={errorText(q.key)}>
              {q.type === "textarea" ? (
                <textarea id={id} rows={4} maxLength={5000} value={String(value ?? "")} onChange={(e) => set(e.target.value)} {...aria(id, errors[q.key])} className={inputClass(errors[q.key])} />
              ) : q.type === "dropdown" ? (
                <select id={id} value={String(value ?? "")} onChange={(e) => set(e.target.value)} {...aria(id, errors[q.key])} className={inputClass(errors[q.key])}>
                  <option value="">{t("selectOption")}</option>
                  {q.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={q.type === "email" ? "email" : q.type === "phone" ? "tel" : "text"}
                  maxLength={q.type === "text" ? 500 : 254}
                  value={String(value ?? "")}
                  onChange={(e) => set(e.target.value)}
                  {...aria(id, errors[q.key])}
                  className={inputClass(errors[q.key])}
                />
              )}
            </Field>
          );
        })}
        {props.turnstileSiteKey ? (
          <Turnstile ref={turnstile} siteKey={props.turnstileSiteKey} language={locale} onToken={setTurnstileToken} />
        ) : null}
        <p className="text-xs text-muted">{t("privacy")}</p>
        <div>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-primary px-6 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {submitting ? t("submitting") : t("submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

function aria(id: string, error: string | undefined) {
  return error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
}

function inputClass(error: string | undefined): string {
  return `w-full rounded-lg border bg-white px-3 py-2.5 text-base text-ink ${error ? "border-danger" : "border-border focus:border-primary"}`;
}

function Field(props: { id: string; label: string; optional?: string; error: string | null; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={props.id} className="mb-1 block text-sm font-medium text-ink">
        {props.label}
        {props.optional ? <span className="font-normal text-muted"> ({props.optional})</span> : null}
      </label>
      {props.children}
      {props.error ? (
        <p id={`${props.id}-error`} className="mt-1 text-sm text-danger">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
