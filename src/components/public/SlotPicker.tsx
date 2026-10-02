"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MonthCalendar } from "./MonthCalendar";
import { TimezoneSelect } from "./TimezoneSelect";
import { addMonths, dateKey, formatLongDate, formatTime, parseKey } from "./time";

export type ClientSlot = { start: string; end: string };

type Props = {
  durations: number[];
  duration: number;
  onDurationChange?: (d: number) => void;
  timezone: string;
  onTimezoneChange: (zone: string) => void;
  /** Last bookable instant (ISO), limits forward month navigation. */
  windowEnd: string;
  loadSlots: (from: string, to: string, duration: number) => Promise<ClientSlot[]>;
  onPick: (slot: ClientSlot) => void;
};

const PAD_MS = 15 * 3_600_000; // covers every UTC offset when fetching a calendar month

/**
 * Date and time selection: optional duration picker, month calendar, time zone switcher
 * and the list of times for the chosen date. Fetches one calendar month at a time; the
 * range is padded so switching time zones never needs a new request.
 */
export function SlotPicker(props: Props) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const { timezone, duration, loadSlots } = props;
  const [now] = useState(() => Date.now());
  const today = dateKey(now, timezone);
  const startMonth = parseKey(today);
  const [month, setMonth] = useState({ y: startMonth.y, m: startMonth.m });
  const [slots, setSlots] = useState<ClientSlot[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const autoAdvance = useRef(2);
  const slotListRef = useRef<HTMLHeadingElement>(null);

  const windowEndKey = dateKey(Date.parse(props.windowEnd), timezone);
  const endMonth = parseKey(windowEndKey);
  const canPrev = month.y * 12 + month.m > startMonth.y * 12 + startMonth.m;
  const canNext = month.y * 12 + month.m < endMonth.y * 12 + endMonth.m;

  useEffect(() => {
    let cancelled = false;
    const from = new Date(Math.max(now, Date.UTC(month.y, month.m - 1, 1) - PAD_MS)).toISOString();
    const to = new Date(Date.UTC(month.y, month.m, 1) + PAD_MS).toISOString();
    loadSlots(from, to, duration).then(
      (list) => {
        if (cancelled) return;
        setError(false);
        setSlots(list);
      },
      () => {
        if (cancelled) return;
        setError(true);
        setSlots([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [month.y, month.m, duration, reload, loadSlots, now]);

  const monthPrefix = `${month.y}-${String(month.m).padStart(2, "0")}`;
  const byDate = useMemo(() => {
    const map = new Map<string, ClientSlot[]>();
    for (const s of slots ?? []) {
      const key = dateKey(Date.parse(s.start), timezone);
      if (!key.startsWith(monthPrefix)) continue;
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return map;
  }, [slots, timezone, monthPrefix]);
  const available = useMemo(() => new Set(byDate.keys()), [byDate]);
  const loading = slots === null;

  // On first load, skip ahead when the current month has nothing left to book.
  useEffect(() => {
    if (loading || error || available.size > 0 || !canNext || autoAdvance.current <= 0) return;
    autoAdvance.current -= 1;
    const next = addMonths(month.y, month.m, 1);
    const id = setTimeout(() => {
      setSlots(null);
      setMonth(next);
    }, 0);
    return () => clearTimeout(id);
  }, [loading, error, available, canNext, month.y, month.m]);

  const changeMonth = useCallback((y: number, m: number) => {
    autoAdvance.current = 0;
    setSlots(null);
    setSelectedDate(null);
    setMonth({ y, m });
  }, []);

  const daySlots = selectedDate ? byDate.get(selectedDate) ?? [] : [];

  return (
    <div className="flex flex-col gap-6">
      {props.durations.length > 1 && props.onDurationChange ? (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-navy">{t("durationLabel")}</legend>
          <div className="flex flex-wrap gap-2">
            {props.durations.map((d) => (
              <label
                key={d}
                className={`cursor-pointer rounded-full border px-4 py-2 text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-primary ${
                  d === duration ? "border-primary bg-primary text-primary-foreground" : "border-border bg-white text-ink hover:border-primary"
                }`}
              >
                <input
                  type="radio"
                  name="duration"
                  value={d}
                  checked={d === duration}
                  onChange={() => {
                    setSlots(null);
                    setSelectedDate(null);
                    props.onDurationChange?.(d);
                  }}
                  className="sr-only"
                />
                {t("durationOption", { count: d })}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
        <section aria-labelledby="pick-date-heading">
          <h2 id="pick-date-heading" className="mb-3 text-lg font-semibold">
            {t("selectDate")}
          </h2>
          <MonthCalendar
            year={month.y}
            month={month.m}
            available={available}
            selected={selectedDate}
            today={today}
            canPrev={canPrev}
            canNext={canNext}
            busy={loading}
            onMonthChange={changeMonth}
            onSelect={(key) => {
              setSelectedDate(key);
              requestAnimationFrame(() => slotListRef.current?.focus());
            }}
          />
          <div className="mt-3 min-h-6 text-sm text-muted" aria-live="polite">
            {loading ? t("loadingSlots") : error ? null : available.size === 0 ? t("noSlotsMonth") : !selectedDate ? t("pickDayHint") : null}
          </div>
          {error ? (
            <div className="mt-2 flex items-center gap-3 text-sm" role="alert">
              <span className="text-danger">{t("slotsError")}</span>
              <button
                type="button"
                className="font-medium text-primary underline"
                onClick={() => {
                  setSlots(null);
                  setReload((r) => r + 1);
                }}
              >
                {t("retry")}
              </button>
            </div>
          ) : null}
          {!loading && !error && available.size === 0 && canNext ? (
            <button
              type="button"
              className="mt-2 text-sm font-medium text-primary underline"
              onClick={() => {
                const n = addMonths(month.y, month.m, 1);
                changeMonth(n.y, n.m);
              }}
            >
              {t("nextAvailable")}
            </button>
          ) : null}
          <div className="mt-5">
            <TimezoneSelect value={timezone} onChange={props.onTimezoneChange} />
          </div>
        </section>

        <section aria-labelledby="pick-time-heading" className={selectedDate ? "" : "hidden md:block"}>
          <h2 id="pick-time-heading" ref={slotListRef} tabIndex={-1} className="mb-3 text-lg font-semibold outline-none">
            {selectedDate ? t("timesFor", { date: formatLongDate(selectedDate, locale) }) : t("selectTime")}
          </h2>
          {selectedDate ? (
            daySlots.length ? (
              <ul className="grid grid-cols-2 gap-2 md:max-h-[26rem] md:grid-cols-1 md:overflow-y-auto md:pr-1">
                {daySlots.map((s) => (
                  <li key={s.start}>
                    <button
                      type="button"
                      onClick={() => props.onPick(s)}
                      className="w-full rounded-lg border border-primary/40 bg-white px-3 py-3 text-center text-sm font-semibold text-primary transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                    >
                      {formatTime(Date.parse(s.start), timezone, locale)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t("noSlotsDay")}</p>
            )
          ) : (
            <p className="hidden text-sm text-muted md:block">{t("pickDayHint")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
