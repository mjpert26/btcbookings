"use client";

import { ActionForm } from "@/components/ui/Form";
import { Checkbox, Fieldset, Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SHOW_AS_LABELS, SHOW_AS_VALUES } from "@/lib/availability";
import { saveSettingsAction } from "./_actions";

export function SettingsForm({
  initial,
}: {
  initial: { unavailableShowAs: string[]; dailyBookingCap: number | null; outlookConflictPolicy: string; notifyHostByEmail: boolean };
}) {
  return (
    <ActionForm action={saveSettingsAction} className="space-y-5" aria-label="Booking preferences">
      <Fieldset legend="Outlook statuses that block time" description="Events with these statuses make you unavailable." errorKey="unavailableShowAs">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SHOW_AS_VALUES.map((v) => (
            <Checkbox key={v} name="unavailableShowAs" value={v} label={SHOW_AS_LABELS[v]} defaultChecked={initial.unavailableShowAs.includes(v)} errorKey="__none" />
          ))}
        </div>
      </Fieldset>
      <Input
        label="Daily booking limit"
        name="dailyBookingCap"
        type="number"
        min={1}
        max={50}
        inputMode="numeric"
        defaultValue={initial.dailyBookingCap ?? ""}
        hint="Leave empty for no limit. Applies across all event types."
        wrapperClassName="max-w-xs"
      />
      <Select
        label="When a booking's Outlook event is moved or deleted"
        name="outlookConflictPolicy"
        defaultValue={initial.outlookConflictPolicy}
        options={[
          { value: "flag", label: "Flag the booking for review" },
          { value: "auto_cancel", label: "Cancel the booking and notify the invitee" },
        ]}
      />
      <Switch name="notifyHostByEmail" label="Email me when someone books" defaultChecked={initial.notifyHostByEmail} description="Outlook invitations are always sent." />
      <SubmitButton>Save preferences</SubmitButton>
    </ActionForm>
  );
}
