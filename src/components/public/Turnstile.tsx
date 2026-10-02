"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("turnstile_load_failed"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export type TurnstileHandle = { reset: () => void };

/**
 * Cloudflare Turnstile widget. Rendered only when a site key is configured; without one
 * the server skips verification outside production.
 */
export const Turnstile = forwardRef<TurnstileHandle, { siteKey: string; language: string; onToken: (t: string | null) => void }>(
  function Turnstile({ siteKey, language, onToken }, ref) {
    const el = useRef<HTMLDivElement>(null);
    const widget = useRef<string | null>(null);
    const tokenCb = useRef(onToken);
    useEffect(() => {
      tokenCb.current = onToken;
    }, [onToken]);

    useImperativeHandle(ref, () => ({
      reset: () => {
        tokenCb.current(null);
        if (widget.current) window.turnstile?.reset(widget.current);
      },
    }));

    useEffect(() => {
      let cancelled = false;
      loadScript()
        .then(() => {
          if (cancelled || !el.current || !window.turnstile) return;
          widget.current = window.turnstile.render(el.current, {
            sitekey: siteKey,
            language,
            callback: (token: string) => tokenCb.current(token),
            "expired-callback": () => tokenCb.current(null),
            "error-callback": () => tokenCb.current(null),
          });
        })
        .catch(() => tokenCb.current(null));
      return () => {
        cancelled = true;
        if (widget.current) window.turnstile?.remove(widget.current);
        widget.current = null;
      };
    }, [siteKey, language]);

    return <div ref={el} className="min-h-[65px]" />;
  },
);
