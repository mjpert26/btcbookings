"use client";

import { ActionForm } from "@/components/ui/Form";
import { Input, Select } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/lib/form-state";

export function AddQueueForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} aria-label="Link a Salesforce Queue">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input label="Queue ID" name="queueId" required placeholder="00G5e000001AbCdEAF" maxLength={18} hint="15 or 18 characters, starting with 00G." autoComplete="off" spellCheck={false} />
        <Input label="Label (optional)" name="queueName" maxLength={120} placeholder="Funding Queue" />
        <SubmitButton pendingLabel="Linking…">Link queue</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function SyncSettingsForm({
  action,
  initial,
}: {
  action: FormAction;
  initial: { membershipSource: string; removalPolicy: string; massRemovalThresholdPct: number };
}) {
  return (
    <ActionForm action={action} className="space-y-4" aria-label="Sync settings">
      <Select
        label="Membership source"
        name="membershipSource"
        defaultValue={initial.membershipSource}
        options={[
          { value: "manual", label: "Manual: admins manage the roster" },
          { value: "salesforce_queue", label: "Salesforce Queue: the roster mirrors linked queues" },
          { value: "queue_plus_manual", label: "Queue plus manual: queue members and manually added members" },
        ]}
      />
      <Select
        label="When a member leaves the queue or is paused"
        name="removalPolicy"
        defaultValue={initial.removalPolicy}
        options={[
          { value: "keep_bookings", label: "Keep their upcoming bookings" },
          { value: "reassign", label: "Reassign upcoming bookings by round-robin" },
        ]}
      />
      <Input
        label="Mass-removal threshold (%)"
        name="massRemovalThresholdPct"
        type="number"
        min={1}
        max={100}
        defaultValue={initial.massRemovalThresholdPct}
        hint="A sync that would pause more than this share of active queue members is blocked and raises an alert."
        wrapperClassName="max-w-xs"
      />
      <SubmitButton>Save sync settings</SubmitButton>
    </ActionForm>
  );
}
