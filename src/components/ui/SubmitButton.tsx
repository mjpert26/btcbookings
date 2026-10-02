"use client";

import type { ComponentProps } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { useFormState } from "@/components/ui/Form";

/** Submit button that shows a pending state while its ActionForm is running. */
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  variant = "primary",
  size = "md",
  className,
  onClick,
  ...props
}: ComponentProps<"button"> & { pendingLabel?: string; variant?: ButtonVariant; size?: ButtonSize }) {
  const { pending } = useFormState();
  return (
    <button
      {...props}
      type="submit"
      aria-disabled={pending || undefined}
      onClick={(e) => {
        if (pending) e.preventDefault();
        onClick?.(e);
      }}
      className={buttonClass(variant, size, className)}
    >
      {pending ? (
        <>
          <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
