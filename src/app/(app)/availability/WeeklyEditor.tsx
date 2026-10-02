"use client";

import { useId, useMemo, useState } from "react";
import type { WeeklyRules } from "@/server/scheduling/types";
import { ActionForm, useFieldError } from "@/components/ui/Form";
import { Select } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IntervalList } from "@/components/app/IntervalList";
import { intervalListError, WEEKDAYS, WEEKDAY_LABELS } from "@/lib/availability";
import type { FormAction } from "@/lib/form-state";
import { saveWeeklyAction } from "./_actions";

function DayRow({ day, rules, setRules, copyToAll }: { day: (typeof WEEKDAYS)[number]; rules: WeeklyRules; setRules: (r: WeeklyRules) => void; copyToAll: () => void }) {
  const id = useId();
  const serverErr = useFieldError(`weekly.${day}`);
  const localErr = intervalListError(rules[day]);
  const err = localErr ?? serverErr;
  return (
    <div className="grid grid-cols-1 gap-2 py-4 sm:grid-cols-[9rem_1fr_auto] sm:items-start">
      <div className="pt-2 font-semibold text-navy" id={`${id}-label`}>
        {WEEKDAY_LABELS[day]}
      </div>
      <div role="group" aria-labelledby={`${id}-label`}>
        <IntervalList
          intervals={rules[day]}
          onChange={(next) => setRules({ ...rules, [day]: next })}
          labelPrefix={WEEKDAY_LABELS[day]}
          error={err ?? undefined}
          errorId={`${id}-err`}
        />
      </div>
      <div className="sm:pt-1">
        <button type="button" onClick={copyToAll} className="rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10">
          Copy to all weekdays<span className="sr-only"> from {WEEKDAY_LABELS[day]}</span>
        </button>
      </div>
    </div>
  );
}

export function WeeklyEditor({ initial, timezone, zones, action = saveWeeklyAction }: { initial: WeeklyRules; timezone: string; zones: string[]; action?: FormAction }) {
  const [rules, setRules] = useState<WeeklyRules>(initial);
  const hasError = useMemo(() => WEEKDAYS.some((d) => intervalListError(rules[d])), [rules]);

  return (
    <ActionForm action={action} aria-label="Weekly hours">
      <input type="hidden" name="weekly" value={JSON.stringify(rules)} />
      <div className="max-w-sm">
        <Select label="Time zone" name="timezone" defaultValue={timezone} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />
      </div>
      <div className="mt-2 divide-y divide-border">
        {WEEKDAYS.map((d) => (
          <DayRow
            key={d}
            day={d}
            rules={rules}
            setRules={setRules}
            copyToAll={() => {
              const src = rules[d];
              const next = { ...rules };
              for (const w of ["mon", "tue", "wed", "thu", "fri"] as const) next[w] = src.map((i) => ({ ...i }));
              setRules(next);
            }}
          />
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <SubmitButton disabled={hasError}>Save weekly hours</SubmitButton>
        {hasError ? <p className="text-sm text-danger">Fix the highlighted days before saving.</p> : null}
      </div>
    </ActionForm>
  );
}
