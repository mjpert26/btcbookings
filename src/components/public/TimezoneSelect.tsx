"use client";

import { useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { allTimezones, zoneOffsetLabel } from "./time";

/** Time zone display with a searchable picker (search box filtering a native list box). */
export function TimezoneSelect({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  const t = useTranslations("booking");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const id = useId();
  const zones = useMemo(() => {
    const list = allTimezones();
    return (list.includes(value) ? list : [value, ...list]).map((z) => ({
      zone: z,
      label: `${z.replace(/_/g, " ")} (${zoneOffsetLabel(z)})`,
    }));
  }, [value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    if (!q) return zones;
    return zones.filter((z) => z.zone.toLowerCase().includes(q) || z.label.toLowerCase().includes(query.trim().toLowerCase()));
  }, [zones, query]);

  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M2.5 10h15M10 2.5c2.2 2.3 2.2 12.7 0 15M10 2.5c-2.2 2.3-2.2 12.7 0 15" />
        </svg>
        <span className="text-muted">{t("timezoneLabel")}:</span>
        <span className="font-medium text-ink">{value.replace(/_/g, " ")}</span>
        <button
          type="button"
          className="rounded px-1 font-medium text-primary underline-offset-2 hover:underline"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => setOpen((o) => !o)}
        >
          {t("timezoneChange")}
        </button>
      </div>
      {open ? (
        <div id={`${id}-panel`} className="mt-2 rounded-brand border border-border bg-white p-3 shadow-sm">
          <label htmlFor={`${id}-search`} className="mb-1 block text-xs font-medium text-muted">
            {t("timezoneSearch")}
          </label>
          <input
            id={`${id}-search`}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-2 w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {filtered.length ? (
            <select
              size={6}
              aria-label={t("timezoneLabel")}
              value={filtered.some((z) => z.zone === value) ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onChange((e.target as HTMLSelectElement).value || value);
                  setOpen(false);
                  setQuery("");
                }
              }}
              className="w-full rounded-md border border-border text-sm"
            >
              {filtered.map((z) => (
                <option key={z.zone} value={z.zone}>
                  {z.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-muted">{t("timezoneNoMatch")}</p>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setQuery("");
              }}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-alt"
            >
              {t("timezoneDone")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
