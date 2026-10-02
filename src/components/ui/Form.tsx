"use client";

import { createContext, startTransition, useActionState, useCallback, useContext, type FormEvent, type ReactNode } from "react";
import { IDLE, type ActionState, type FormAction } from "@/lib/form-state";
import { cn } from "@/lib/cn";
import { InlineStatus, useToast } from "@/components/ui/Toast";

type FormCtx = { state: ActionState; pending: boolean };
const FormContext = createContext<FormCtx>({ state: IDLE, pending: false });

export function useFormState(): FormCtx {
  return useContext(FormContext);
}

/** Error message for a field name from the nearest ActionForm, if any. */
export function useFieldError(name: string | undefined): string | undefined {
  const { state } = useContext(FormContext);
  if (!name) return undefined;
  return state.fieldErrors?.[name];
}

/**
 * A form bound to a server action through useActionState. Submissions go through
 * onSubmit so React does not reset the fields after an error; the `action` attribute
 * still works before hydration. Field components read errors from context.
 */
export function ActionForm({
  action,
  children,
  className,
  showStatus = true,
  "aria-label": ariaLabel,
  id,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  showStatus?: boolean;
  "aria-label"?: string;
  id?: string;
}) {
  // Success goes to the page-level toast region when present; errors stay next to the form.
  // The toast is pushed when the action resolves (not in an effect) so it still appears
  // when revalidation removes this form, e.g. a table row that no longer matches a filter.
  const toast = useToast();
  const run = useCallback(
    async (prev: ActionState, fd: FormData) => {
      const result = await action(prev, fd);
      if (toast && result.status === "success" && result.message) toast.push(result.message);
      return result;
    },
    [action, toast],
  );
  const [state, formAction, pending] = useActionState(run, IDLE);
  const toasted = Boolean(toast);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const fd = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(fd));
  }

  return (
    <FormContext value={{ state, pending }}>
      <form id={id} action={formAction} onSubmit={onSubmit} className={cn(className)} aria-label={ariaLabel} noValidate>
        {children}
        {showStatus ? <InlineStatus state={state} className="mt-3" errorsOnly={toasted} /> : null}
      </form>
    </FormContext>
  );
}

/** Status line for an ActionForm rendered somewhere other than the bottom of the form. */
export function FormStatusSlot({ className }: { className?: string }) {
  const { state } = useFormState();
  return <InlineStatus state={state} className={className} />;
}
