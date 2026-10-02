"use client";

import { useId, useState } from "react";
import type { Interval } from "@/server/scheduling/types";
import { ActionForm, useFieldError } from "@/components/ui/Form";
import { Input } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IntervalList } from "@/components/app/IntervalList";
import { intervalListError } from "@/lib/availability";
import { addOverrideAction } from "./_actions";

function Hours({ intervals, setIntervals }: { intervals: Interval[]; setIntervals: (i: Interval[]) => void }) {
  const id = useId();
  const serverErr = useFieldError("intervals");
  const err = intervalListError(intervals) ?? serverErr;
  return <IntervalList intervals={intervals} onChange={setIntervals} labelPrefix="Override" error={err ?? undefined} errorId={`${id}-err`} />;
}

export function OverrideForm({ minDate }: { minDate: string }) {
  const [mode, setMode] = useState<"closed" | "custom">("closed");
  const [intervals, setIntervals] = useState<Interval[]>([{ start: "10:00", end: "14:00" }]);
  const name = useId();
  return (
    <ActionForm action={addOverrideAction} className="space-y-4" aria-label="Add a date override">
      <input type="hidden" name="intervals" value={JSON.stringify(mode === "closed" ? [] : intervals)} />
      <Input label="Date" type="date" name="date" min={minDate} required wrapperClassName="max-w-xs" />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-navy">Availability on this date</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${name}-mode`} checked={mode === "closed"} onChange={() => setMode("closed")} className="accent-primary" />
            Unavailable all day
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${name}-mode`} checked={mode === "custom"} onChange={() => setMode("custom")} className="accent-primary" />
            Custom hours
          </label>
        </div>
      </fieldset>
      {mode === "custom" ? <Hours intervals={intervals} setIntervals={setIntervals} /> : null}
      <SubmitButton>Add override</SubmitButton>
    </ActionForm>
  );
}
