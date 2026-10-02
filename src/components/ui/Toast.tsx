"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ActionState } from "@/lib/form-state";
import { cn } from "@/lib/cn";

type ToastItem = { id: number; message: string; tone: "success" | "error" };
type ToastApi = { push: (message: string, tone?: ToastItem["tone"]) => void };

const ToastContext = createContext<ToastApi | null>(null);

/** Returns the toast API, or null outside a ToastProvider. */
export function useToast(): ToastApi | null {
  return useContext(ToastContext);
}

let nextId = 0;

/**
 * Page-level toast region. It lives in the app layout, so confirmations stay visible even
 * when the form that produced them disappears after revalidation (for example a row that
 * no longer matches a filter). Announced politely; each toast dismisses after 6 seconds.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string, tone: ToastItem["tone"] = "success") => {
    const id = ++nextId;
    setItems((list) => [...list.slice(-3), { id, message, tone }]);
    window.setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);
  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:right-6">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "btc-fade-up pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-surface px-4 py-3 text-sm shadow-lg",
              t.tone === "error" ? "border-danger/40" : "border-success/40",
            )}
          >
            <span aria-hidden="true" className={cn("mt-0.5 font-bold", t.tone === "error" ? "text-danger" : "text-success")}>
              {t.tone === "error" ? "!" : "✓"}
            </span>
            <p className="flex-1 text-ink">{t.message}</p>
            <button type="button" onClick={() => dismiss(t.id)} className="rounded px-1 text-muted hover:text-navy" aria-label="Dismiss notification">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

/**
 * Inline status message for form results. Success is announced politely; errors use
 * role="alert" so screen readers announce them immediately.
 */
export function InlineStatus({ state, className, errorsOnly = false }: { state: ActionState; className?: string; errorsOnly?: boolean }) {
  if (state.status === "idle" || !state.message || (errorsOnly && state.status === "success")) {
    return <div aria-live="polite" className="sr-only" />;
  }
  const error = state.status === "error";
  return (
    <div
      key={state.ts}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        error ? "border-danger/30 bg-danger/5 text-danger" : "border-success/30 bg-success/5 text-success",
        className,
      )}
    >
      <span aria-hidden="true" className="mt-0.5 font-bold">
        {error ? "!" : "✓"}
      </span>
      <span>{state.message}</span>
    </div>
  );
}

/** Static notice block. */
export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-primary/30 bg-primary/5 text-navy",
    success: "border-success/30 bg-success/5 text-success",
    warning: "border-warning/40 bg-warning/5 text-warning",
    danger: "border-danger/30 bg-danger/5 text-danger",
  } as const;
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={cn("rounded-lg border px-4 py-3 text-sm", tones[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title && "mt-1", "text-ink")}>{children}</div> : null}
    </div>
  );
}
