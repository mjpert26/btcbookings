"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useFieldError } from "@/components/ui/Form";

export const controlClass =
  "block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink shadow-xs " +
  "placeholder:text-muted/80 hover:border-primary/40 focus-visible:border-primary " +
  "disabled:cursor-not-allowed disabled:bg-surface-alt disabled:text-muted " +
  "aria-invalid:border-danger aria-invalid:ring-1 aria-invalid:ring-danger";

type FieldShellProps = {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
};

function FieldShell({ id, label, hint, error, required, hideLabel, className, children }: FieldShellProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium text-navy", hideLabel && "sr-only")}>
        {label}
        {required ? (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

type CommonProps = {
  label: ReactNode;
  hint?: ReactNode;
  /** Overrides the error read from the surrounding ActionForm. */
  error?: string;
  hideLabel?: boolean;
  wrapperClassName?: string;
  /** Field error key, when it differs from `name`. */
  errorKey?: string;
};

export function Input({ label, hint, error, hideLabel, wrapperClassName, errorKey, className, id, ...props }: ComponentProps<"input"> & CommonProps) {
  const auto = useId();
  const fid = id ?? auto;
  const ctxError = useFieldError(errorKey ?? props.name);
  const err = error ?? ctxError;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={err} required={props.required} hideLabel={hideLabel} className={wrapperClassName}>
      <input
        id={fid}
        aria-invalid={err ? true : undefined}
        aria-describedby={describedBy(fid, hint, err)}
        className={cn(controlClass, className)}
        {...props}
      />
    </FieldShell>
  );
}

export function Textarea({ label, hint, error, hideLabel, wrapperClassName, errorKey, className, id, ...props }: ComponentProps<"textarea"> & CommonProps) {
  const auto = useId();
  const fid = id ?? auto;
  const ctxError = useFieldError(errorKey ?? props.name);
  const err = error ?? ctxError;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={err} required={props.required} hideLabel={hideLabel} className={wrapperClassName}>
      <textarea
        id={fid}
        rows={props.rows ?? 3}
        aria-invalid={err ? true : undefined}
        aria-describedby={describedBy(fid, hint, err)}
        className={cn(controlClass, "min-h-20", className)}
        {...props}
      />
    </FieldShell>
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({
  label,
  hint,
  error,
  hideLabel,
  wrapperClassName,
  errorKey,
  className,
  id,
  options,
  placeholder,
  ...props
}: ComponentProps<"select"> & CommonProps & { options: SelectOption[]; placeholder?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const ctxError = useFieldError(errorKey ?? props.name);
  const err = error ?? ctxError;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={err} required={props.required} hideLabel={hideLabel} className={wrapperClassName}>
      <select
        id={fid}
        aria-invalid={err ? true : undefined}
        aria-describedby={describedBy(fid, hint, err)}
        className={cn(controlClass, "pr-8", className)}
        {...props}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function Checkbox({
  label,
  hint,
  error,
  errorKey,
  wrapperClassName,
  className,
  id,
  ...props
}: Omit<ComponentProps<"input">, "type"> & Omit<CommonProps, "hideLabel">) {
  const auto = useId();
  const fid = id ?? auto;
  const ctxError = useFieldError(errorKey ?? props.name);
  const err = error ?? ctxError;
  return (
    <div className={cn("flex items-start gap-2.5", wrapperClassName)}>
      <input
        id={fid}
        type="checkbox"
        aria-invalid={err ? true : undefined}
        aria-describedby={describedBy(fid, hint, err)}
        className={cn("mt-0.5 size-4 shrink-0 rounded border-border accent-primary", className)}
        {...props}
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={fid} className="text-sm font-medium text-ink">
          {label}
        </label>
        {hint && !err ? (
          <p id={`${fid}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
        {err ? (
          <p id={`${fid}-error`} className="text-xs font-medium text-danger">
            {err}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Group of related controls with a visible legend and a shared error slot. */
export function Fieldset({
  legend,
  description,
  errorKey,
  children,
  className,
  disabled,
}: {
  legend: ReactNode;
  description?: ReactNode;
  errorKey?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const auto = useId();
  const err = useFieldError(errorKey);
  return (
    <fieldset
      disabled={disabled}
      aria-describedby={err ? `${auto}-error` : description ? `${auto}-desc` : undefined}
      className={cn("min-w-0 space-y-3", className)}
    >
      <legend className="font-heading text-base font-semibold text-navy">{legend}</legend>
      {description ? (
        <p id={`${auto}-desc`} className="-mt-1 text-sm text-muted">
          {description}
        </p>
      ) : null}
      {children}
      {err ? (
        <p id={`${auto}-error`} className="text-sm font-medium text-danger">
          {err}
        </p>
      ) : null}
    </fieldset>
  );
}
