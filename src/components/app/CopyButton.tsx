"use client";

import { useState } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";

/** Copies text to the clipboard. The result is announced through a polite live region. */
export function CopyButton({ text, label = "Copy link", variant = "secondary", size = "sm" }: { text: string; label?: string; variant?: ButtonVariant; size?: ButtonSize }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    const value = text.startsWith("/") ? `${window.location.origin}${text}` : text;
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <button type="button" onClick={copy} className={buttonClass(variant, size)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
          {state === "copied" ? <path d="M5 13l4 4L19 7" /> : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>}
        </svg>
        {state === "copied" ? "Copied" : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Link copied to clipboard" : state === "failed" ? "Could not copy the link" : ""}
      </span>
    </>
  );
}
