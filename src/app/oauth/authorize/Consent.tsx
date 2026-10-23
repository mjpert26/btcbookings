"use client";

import { useState, useTransition } from "react";
import { decideAuthorization } from "./actions";

export function Consent({ query }: { query: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: "allow" | "deny") =>
    start(async () => {
      const r = await decideAuthorization(query, decision);
      if ("error" in r) setError(r.error);
      else window.location.assign(r.redirectTo);
    });
  return (
    <div className="mt-8 space-y-3">
      {error ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("deny")}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-5 text-sm font-semibold text-ink hover:bg-surface-alt disabled:opacity-60"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("allow")}
          className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? "Working…" : "Allow access"}
        </button>
      </div>
    </div>
  );
}
