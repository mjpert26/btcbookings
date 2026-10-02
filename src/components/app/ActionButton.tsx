"use client";

import { ActionForm } from "@/components/ui/Form";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { ButtonSize, ButtonVariant } from "@/components/ui/Button";
import type { FormAction } from "@/lib/form-state";

/** A single-button form bound to a server action, with an inline result message. */
export function ActionButton({
  action,
  children,
  pendingLabel,
  variant = "secondary",
  size = "md",
  hidden,
  className,
}: {
  action: FormAction;
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  hidden?: Record<string, string>;
  className?: string;
}) {
  return (
    <ActionForm action={action} className={className}>
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel}>
        {children}
      </SubmitButton>
    </ActionForm>
  );
}
