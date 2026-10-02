"use client";

import { ActionForm } from "@/components/ui/Form";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { removeOverrideAction } from "./_actions";

export function RemoveOverride({ id, label }: { id: string; label: string }) {
  return (
    <ActionForm action={removeOverrideAction} showStatus={false}>
      <input type="hidden" name="overrideId" value={id} />
      <SubmitButton variant="ghost" size="sm" pendingLabel="Removing…" className="text-danger">
        Remove<span className="sr-only"> override for {label}</span>
      </SubmitButton>
    </ActionForm>
  );
}
