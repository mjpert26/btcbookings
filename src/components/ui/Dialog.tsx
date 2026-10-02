"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const DialogClose = createContext<() => void>(() => {});

/** Returns a function that closes the surrounding Dialog. */
export function useDialogClose(): () => void {
  return useContext(DialogClose);
}

/** Button that closes the surrounding Dialog. */
export function DialogCloseButton({ children, variant = "secondary" }: { children: ReactNode; variant?: ButtonVariant }) {
  const close = useDialogClose();
  return (
    <button type="button" className={buttonClass(variant)} onClick={close}>
      {children}
    </button>
  );
}

/**
 * Modal dialog built on the native <dialog> element opened with showModal(), which makes
 * the rest of the page inert (focus stays inside) and closes on Escape. Focus returns to
 * the trigger on close. Tab wrapping is enforced explicitly for older browsers.
 */
export function Dialog({
  trigger,
  triggerVariant = "secondary",
  triggerSize = "md",
  title,
  description,
  children,
  className,
}: {
  trigger: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    ref.current?.close();
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== "Tab" || !ref.current) return;
    const items = ref.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <button ref={triggerRef} type="button" className={buttonClass(triggerVariant, triggerSize)} onClick={() => setOpen(true)} aria-haspopup="dialog">
        {trigger}
      </button>
      {open ? (
        <dialog
          ref={ref}
          aria-labelledby={`${id}-title`}
          aria-describedby={description ? `${id}-desc` : undefined}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            if (e.target === ref.current) close();
          }}
          className={cn(
            "m-auto w-[min(32rem,calc(100vw-2rem))] rounded-brand border border-border bg-surface p-0 text-ink shadow-xl backdrop:bg-navy/50",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <h2 id={`${id}-title`} className="text-lg font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={`${id}-desc`} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <button type="button" onClick={close} className="rounded-md p-1 text-muted hover:bg-surface-alt hover:text-navy" aria-label="Close dialog">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <DialogClose value={close}>
            <div className="px-5 py-4">{children}</div>
          </DialogClose>
        </dialog>
      ) : null}
    </>
  );
}
