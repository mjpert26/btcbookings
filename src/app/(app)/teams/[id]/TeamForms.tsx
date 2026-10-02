"use client";

import { ActionForm } from "@/components/ui/Form";
import { Input, Select } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/lib/form-state";

export function AddMemberForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} aria-label="Add a manual member">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input label="Add member by email" name="email" type="email" required placeholder="name@bigthinkcapital.com" wrapperClassName="flex-1" autoComplete="off" />
        <SubmitButton pendingLabel="Adding…">Add member</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function TeamSettingsForm({
  action,
  initial,
}: {
  action: FormAction;
  initial: { outlookConflictPolicy: string; removalPolicy: string; massRemovalThresholdPct: number };
}) {
  return (
    <ActionForm action={action} className="space-y-4" aria-label="Team settings">
      <Select
        label="When a booking's Outlook event is moved or deleted"
        name="outlookConflictPolicy"
        defaultValue={initial.outlookConflictPolicy}
        options={[
          { value: "flag", label: "Flag for review" },
          { value: "auto_cancel", label: "Cancel and notify the invitee" },
        ]}
      />
      <Select
        label="When a member is removed from the queue"
        name="removalPolicy"
        defaultValue={initial.removalPolicy}
        options={[
          { value: "keep_bookings", label: "Keep their upcoming bookings" },
          { value: "reassign", label: "Reassign upcoming bookings by round-robin" },
        ]}
      />
      <Input
        label="Mass-removal safety threshold (%)"
        name="massRemovalThresholdPct"
        type="number"
        min={1}
        max={100}
        defaultValue={initial.massRemovalThresholdPct}
        hint="If a sync would pause more than this share of active queue members, nothing changes and admins get an alert."
        wrapperClassName="max-w-xs"
      />
      <SubmitButton>Save settings</SubmitButton>
    </ActionForm>
  );
}

export function AddAdminForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} aria-label="Add a team admin">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input label="Add team admin by email" name="email" type="email" required wrapperClassName="flex-1" autoComplete="off" />
        <SubmitButton variant="secondary" pendingLabel="Adding…">
          Add admin
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
