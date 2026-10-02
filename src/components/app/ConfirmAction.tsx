"use client";

import { Dialog, DialogCloseButton } from "@/components/ui/Dialog";
import { ActionForm } from "@/components/ui/Form";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { ButtonSize, ButtonVariant } from "@/components/ui/Button";
import type { FormAction } from "@/lib/form-state";

/** Button that opens a confirmation dialog before running a destructive server action. */
export function ConfirmAction({
  action,
  trigger,
  title,
  description,
  confirmLabel,
  hidden,
  variant = "danger",
  triggerVariant = "secondary",
  triggerSize = "md",
}: {
  action: FormAction;
  trigger: string;
  title: string;
  description: string;
  confirmLabel: string;
  hidden?: Record<string, string>;
  variant?: ButtonVariant;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
}) {
  return (
    <Dialog trigger={trigger} triggerVariant={triggerVariant} triggerSize={triggerSize} title={title} description={description}>
      <ActionForm action={action} className="flex flex-col gap-4">
        {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
        <div className="flex justify-end gap-2">
          <DialogCloseButton>Cancel</DialogCloseButton>
          <SubmitButton variant={variant} pendingLabel="Working…">
            {confirmLabel}
          </SubmitButton>
        </div>
      </ActionForm>
    </Dialog>
  );
}
