"use client";

import { useActionState, useState } from "react";
import { createApiKeyAction, type NewKeyState } from "../../settings/_actions";

const IDLE: NewKeyState = { status: "idle" };

export function NewApiKey() {
  const [state, action, pending] = useActionState(createApiKeyAction, IDLE);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm">
          <span className="block font-semibold text-ink">Key name</span>
          <input name="name" required maxLength={100} placeholder="For example: n8n workflows" className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
        </label>
        <label className="text-sm">
          <span className="block font-semibold text-ink">Expires</span>
          <select name="expires" defaultValue="90" className="mt-1 h-10 rounded-lg border border-border px-3">
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In 1 year</option>
            <option value="never">Never</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
          {pending ? "Creating…" : "Create API key"}
        </button>
      </form>
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}
      {state.status === "success" && state.key ? (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
          <p className="font-semibold text-ink">{state.message}</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="block flex-1 overflow-x-auto rounded bg-surface-alt px-3 py-2 font-mono text-xs">{state.key}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(state.key!).then(() => setCopied(true))}
              className="h-9 rounded-lg border border-border px-3 text-sm font-semibold hover:bg-surface-alt"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
