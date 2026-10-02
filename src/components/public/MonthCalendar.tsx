"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { addDays, addMonths, formatLongDate, formatMonth, monthGrid, parseKey, weekdayNames } from "./time";

type Props = {
  year: number;
  month: number;
  /** Dates (YYYY-MM-DD) that have at least one slot. */
  available: Set<string>;
  selected: string | null;
  today: string;
  canPrev: boolean;
  canNext: boolean;
  onMonthChange: (y: number, m: number) => void;
  onSelect: (key: string) => void;
  busy?: boolean;
};

/**
 * Month calendar following the WAI-ARIA date grid pattern: one tab stop, arrow keys move
 * by day and week, Home/End to week start/end, PageUp/PageDown by month, Enter or Space
 * selects. Dates without slots stay focusable for navigation but cannot be selected.
 */
export function MonthCalendar(props: Props) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const weeks = useMemo(() => monthGrid(props.year, props.month), [props.year, props.month]);
  const shortDays = useMemo(() => weekdayNames(locale, "short"), [locale]);
  const longDays = useMemo(() => weekdayNames(locale, "long"), [locale]);
  const monthPrefix = `${props.year}-${String(props.month).padStart(2, "0")}`;

  const firstAvailable = weeks.flat().find((k) => k && props.available.has(k)) ?? null;
  const defaultFocus =
    props.selected?.startsWith(monthPrefix) ? props.selected : firstAvailable ?? (props.today.startsWith(monthPrefix) ? props.today : `${monthPrefix}-01`);
  const [focusKey, setFocusKey] = useState<string>(defaultFocus);
  const pendingFocus = useRef(false);
  const gridRef = useRef<HTMLTableElement>(null);

  // Keep the roving tab stop inside the visible month.
  const activeKey = focusKey.startsWith(monthPrefix) ? focusKey : defaultFocus;

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${activeKey}"]`)?.focus();
  }, [activeKey, props.year, props.month]);

  function moveTo(key: string) {
    const { y, m } = parseKey(key);
    if (y !== props.year || m !== props.month) {
      const forward = key > activeKey;
      if ((forward && !props.canNext) || (!forward && !props.canPrev)) return;
      props.onMonthChange(y, m);
    }
    pendingFocus.current = true;
    setFocusKey(key);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: string) {
    const { y, m, d } = parseKey(key);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    let next: string | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = addDays(key, -1);
        break;
      case "ArrowRight":
        next = addDays(key, 1);
        break;
      case "ArrowUp":
        next = addDays(key, -7);
        break;
      case "ArrowDown":
        next = addDays(key, 7);
        break;
      case "Home":
        next = addDays(key, -weekday);
        break;
      case "End":
        next = addDays(key, 6 - weekday);
        break;
      case "PageUp":
      case "PageDown": {
        const to = addMonths(y, m, e.key === "PageUp" ? -1 : 1);
        const last = new Date(Date.UTC(to.y, to.m, 0)).getUTCDate();
        next = `${to.y}-${String(to.m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    moveTo(next);
  }

  const monthName = formatMonth(props.year, props.month, locale);
  const title = monthName.charAt(0).toLocaleUpperCase(locale) + monthName.slice(1);
  const prev = addMonths(props.year, props.month, -1);
  const next = addMonths(props.year, props.month, 1);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold text-navy" id="calendar-title" aria-live="polite">
          {title}
        </h3>
        <div className="flex gap-1">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-primary hover:bg-surface-alt disabled:cursor-not-allowed disabled:text-muted/50"
            onClick={() => props.onMonthChange(prev.y, prev.m)}
            disabled={!props.canPrev}
            aria-label={t("previousMonth")}
          >
            <Chevron dir="left" />
          </button>
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-primary hover:bg-surface-alt disabled:cursor-not-allowed disabled:text-muted/50"
            onClick={() => props.onMonthChange(next.y, next.m)}
            disabled={!props.canNext}
            aria-label={t("nextMonth")}
          >
            <Chevron dir="right" />
          </button>
        </div>
      </div>
      <table ref={gridRef} role="grid" aria-labelledby="calendar-title" aria-busy={props.busy || undefined} className="w-full table-fixed border-collapse">
        <thead>
          <tr>
            {shortDays.map((d, i) => (
              <th key={d} scope="col" abbr={longDays[i]} className="pb-2 text-center text-xs font-medium uppercase tracking-wide text-muted">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((key, di) => {
                if (!key) return <td key={di} />;
                const available = props.available.has(key);
                const selected = props.selected === key;
                const isToday = key === props.today;
                const label = t(available ? "dayAvailable" : "dayUnavailable", { date: formatLongDate(key, locale) });
                return (
                  <td key={key} className="p-0.5 text-center" role="gridcell" aria-selected={selected || undefined}>
                    <button
                      type="button"
                      data-date={key}
                      tabIndex={key === activeKey ? 0 : -1}
                      aria-label={label}
                      aria-disabled={!available || undefined}
                      onKeyDown={(e) => onKeyDown(e, key)}
                      onFocus={() => setFocusKey(key)}
                      onClick={() => available && props.onSelect(key)}
                      className={[
                        "relative mx-auto flex h-11 w-11 items-center justify-center rounded-full text-sm transition-colors",
                        selected
                          ? "bg-primary font-semibold text-primary-foreground"
                          : available
                            ? "bg-primary/10 font-semibold text-primary hover:bg-primary/20"
                            : "cursor-default text-muted/70",
                      ].join(" ")}
                    >
                      {Number(key.slice(8))}
                      {isToday ? (
                        <span
                          aria-hidden="true"
                          className={`absolute bottom-1.5 h-1 w-1 rounded-full ${selected ? "bg-primary-foreground" : "bg-primary"}`}
                        />
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d={dir === "left" ? "M12.5 15l-5-5 5-5" : "M7.5 5l5 5-5 5"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
