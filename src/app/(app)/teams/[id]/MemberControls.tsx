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
