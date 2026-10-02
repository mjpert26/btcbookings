"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useFieldError } from "@/components/ui/Form";

/**
 * Accessible on/off switch (role="switch"). Posts `name=on` when on and `name=off`
 * when off, so server actions can read it with bool().
 */
export function Switch({
  name,
  label,
  description,
  defaultChecked = false,
  checked: controlled,
  onCheckedChange,
  disabled,
  size = "md",
  className,
}: {
  name?: string;
  label: ReactNode;
  description?: ReactNode;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  size?: "md" | "lg";
  className?: string;
}) {
  const id = useId();
  const [inner, setInner] = useState(defaultChecked);
  const on = controlled ?? inner;
  const err = useFieldError(name);

  function toggle() {
    if (disabled) return;
    const next = !on;
    if (controlled === undefined) setInner(next);
    onCheckedChange?.(next);
  }

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-60",
          size === "lg" ? "h-8 w-14" : "h-6 w-11",
          on ? "bg-primary" : "bg-muted/40",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block rounded-full bg-white shadow transition-transform",
            size === "lg" ? "size-7" : "size-5",
            on ? (size === "lg" ? "translate-x-6" : "translate-x-5") : "translate-x-0",
          )}
        />
      </button>
      {name ? <input type="hidden" name={name} value={on ? "on" : "off"} /> : null}
      <div className="flex flex-col gap-0.5">
        <span id={`${id}-label`} className={cn("font-medium text-ink", size === "lg" ? "text-base" : "text-sm")} onClick={toggle}>
          {label}
        </span>
        {description ? (
          <span id={`${id}-desc`} className="text-xs text-muted">
            {description}
          </span>
        ) : null}
        {err ? <span className="text-xs font-medium text-danger">{err}</span> : null}
      </div>
    </div>
  );
}
