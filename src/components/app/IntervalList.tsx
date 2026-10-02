"use client";

import type { Interval } from "@/server/scheduling/types";
import { controlClass } from "@/components/ui/Field";
import { cn } from "@/lib/cn";

/** Editable list of time intervals for one day. Times use native time inputs (24-hour values). */
export function IntervalList({
  intervals,
  onChange,
  labelPrefix,
  error,
  errorId,
}: {
  intervals: Interval[];
  onChange: (next: Interval[]) => void;
  labelPrefix: string;
  error?: string;
  errorId?: string;
}) {
  function update(i: number, patch: Partial<Interval>) {
    onChange(intervals.map((iv, k) => (k === i ? { ...iv, ...patch } : iv)));
  }
  function add() {
    const last = intervals[intervals.length - 1];
    const next: Interval = last ? { start: last.end < "23:00" ? last.end : "09:00", end: last.end < "23:00" ? bump(last.end) : "17:00" } : { start: "09:30", end: "18:30" };
    onChange([...intervals, next]);
  }
  return (
    <div className="flex flex-col gap-2">
      {intervals.length === 0 ? <p className="py-2 text-sm text-muted">Unavailable</p> : null}
      {intervals.map((iv, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`${labelPrefix}-${i}-start`}>
            {labelPrefix} interval {i + 1} start
          </label>
          <input
            id={`${labelPrefix}-${i}-start`}
            type="time"
            step={300}
            value={iv.start}
            onChange={(e) => update(i, { start: e.target.value })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(controlClass, "w-32")}
          />
          <span aria-hidden="true" className="text-muted">
            –
          </span>
          <label className="sr-only" htmlFor={`${labelPrefix}-${i}-end`}>
            {labelPrefix} interval {i + 1} end
          </label>
          <input
            id={`${labelPrefix}-${i}-end`}
            type="time"
            step={300}
            value={iv.end}
            onChange={(e) => update(i, { end: e.target.value })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(controlClass, "w-32")}
          />
          <button
            type="button"
            onClick={() => onChange(intervals.filter((_, k) => k !== i))}
            className="rounded-md px-2 py-1.5 text-sm font-medium text-danger hover:bg-danger/5"
          >
            Remove<span className="sr-only"> {labelPrefix} interval {i + 1}</span>
          </button>
        </div>
      ))}
      <div>
        <button type="button" onClick={add} className="rounded-md px-2 py-1 text-sm font-semibold text-primary hover:bg-primary/10">
          + Add hours<span className="sr-only"> for {labelPrefix}</span>
        </button>
      </div>
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function bump(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const nh = Math.min(23, h + 1);
  return `${String(nh).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
