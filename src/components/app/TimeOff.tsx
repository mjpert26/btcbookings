"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm, useFormState } from "@/components/ui/Form";
import { Input, Textarea } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Notice } from "@/components/ui/Toast";
import type { FormAction } from "@/lib/form-state";
import { TIME_OFF_NOTE_MAX } from "@/lib/time-off";

/** Lists the bookings inside a block that was just saved, so they can be rescheduled. */
function OverlapWarning() {
  const { state } = useFormState();
  if (state.status !== "success" || !state.warnings?.length) return null;
  return (
    <Notice tone="warning" title="These bookings are inside the time off" className="mt-3">
      <p className="text-sm">They were not cancelled or moved. Reschedule them or let the invitees know.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {state.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </Notice>
  );
}

/** Clears the form fields after a successful save so the next block starts empty. */
function ResetOnSuccess({ onReset }: { onReset: () => void }) {
  const { state } = useFormState();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (state.status !== "success") return;
    ref.current?.closest("form")?.reset();
    onReset();
    // Runs once per response; ts changes on every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ts]);
  return <span ref={ref} hidden />;
}

/**
 * Adds a time-off block: whole days (All day on) or a time window. Dates and times are read
 * in `timezone` on the server. Pass `userId` when an admin adds time off for someone else.
 */
export function TimeOffForm({
  action,
  minDate,
  timezone,
  userId,
}: {
  action: FormAction;
  minDate: string;
  timezone: string;
  userId?: string;
}) {
  const [allDay, setAllDay] = useState(true);
  const [startDate, setStartDate] = useState("");
  return (
    <ActionForm action={action} className="space-y-4" aria-label="Add time off">
      {userId ? <input type="hidden" name="userId" value={userId} /> : null}
      <Switch
        name="allDay"
        label="All day"
        checked={allDay}
        onCheckedChange={setAllDay}
        description={allDay ? "Blocks whole days, from midnight to midnight." : "Blocks the time between the start and the end."}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Start date"
          type="date"
          name="startDate"
          min={minDate}
          required
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
        {allDay ? null : <Input label="Start time" type="time" name="startTime" required />}
        <Input
          label="End date"
          type="date"
          name="endDate"
          min={startDate || minDate}
          hint={allDay ? "Leave empty for a single day." : "Leave empty to end on the start date."}
        />
        {allDay ? null : <Input label="End time" type="time" name="endTime" required />}
      </div>
      <Textarea
        label="Note (optional)"
        name="note"
        rows={2}
        maxLength={TIME_OFF_NOTE_MAX}
        hint={`Only ${userId ? "this person" : "you"} and admins see this. It is never shown on booking pages.`}
      />
      <p className="text-xs text-muted">Times are in {timezone}. Existing bookings are not changed.</p>
      <SubmitButton>Add time off</SubmitButton>
      <OverlapWarning />
      <ResetOnSuccess onReset={() => setStartDate("")} />
    </ActionForm>
  );
}

/** Delete button for one block. */
export function DeleteTimeOff({ action, id, label }: { action: FormAction; id: string; label: string }) {
  return (
    <ActionForm action={action} showStatus={false}>
      <input type="hidden" name="timeOffId" value={id} />
      <SubmitButton variant="ghost" size="sm" pendingLabel="Deleting…" className="text-danger">
        Delete<span className="sr-only"> time off {label}</span>
      </SubmitButton>
    </ActionForm>
  );
}
