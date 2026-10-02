"use client";

import { Dialog, DialogCloseButton } from "@/components/ui/Dialog";
import { ActionForm } from "@/components/ui/Form";
import { Input } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/lib/form-state";

export function MemberStatusButton({ action, memberId, status, name }: { action: FormAction; memberId: string; status: string; name: string }) {
  const pausing = status !== "paused";
  return (
    <ActionForm action={action}>
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="status" value={pausing ? "paused" : "active"} />
      <SubmitButton variant={pausing ? "secondary" : "subtle"} size="sm" pendingLabel={pausing ? "Pausing…" : "Resuming…"}>
        {pausing ? "Pause" : "Unpause"}
        <span className="sr-only"> {name}</span>
      </SubmitButton>
    </ActionForm>
  );
}

/** Removes a manual member after confirmation. Errors (for example upcoming bookings) show in the dialog. */
export function MemberRemoveButton({ action, memberId, name }: { action: FormAction; memberId: string; name: string }) {
  return (
    <Dialog
      trigger={<>Remove<span className="sr-only"> {name}</span></>}
      triggerSize="sm"
      triggerVariant="ghost"
      title={`Remove ${name} from the team?`}
      description="The member's round-robin history is deleted and they are removed from the team's Slack channels in add-and-remove mode. Members with upcoming bookings on this team must be paused instead."
    >
      <ActionForm action={action} className="flex flex-col gap-4">
        <input type="hidden" name="memberId" value={memberId} />
        <div className="flex justify-end gap-2">
          <DialogCloseButton>Cancel</DialogCloseButton>
          <SubmitButton variant="danger" pendingLabel="Removing…">
            Remove member
          </SubmitButton>
        </div>
      </ActionForm>
    </Dialog>
  );
}

export function MemberEditDialog({
  action,
  member,
}: {
  action: FormAction;
  member: { id: string; name: string; weight: number; priority_tier: number; daily_cap: number | null };
}) {
  return (
    <Dialog trigger={<>Edit<span className="sr-only"> {member.name}</span></>} triggerSize="sm" triggerVariant="ghost" title={`Edit ${member.name}`} description="Round-robin settings for this team.">
      <ActionForm action={action} className="space-y-4">
        <input type="hidden" name="memberId" value={member.id} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Weight" name="weight" type="number" min={0} max={1000} defaultValue={member.weight} hint="Higher gets more meetings (weighted)." />
          <Input label="Priority tier" name="priorityTier" type="number" min={1} max={10} defaultValue={member.priority_tier} hint="1 is offered first." />
          <Input label="Daily cap" name="dailyCap" type="number" min={1} max={50} defaultValue={member.daily_cap ?? ""} hint="Empty for none." />
        </div>
        <div className="flex justify-end gap-2">
          <DialogCloseButton>Close</DialogCloseButton>
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </Dialog>
  );
}
