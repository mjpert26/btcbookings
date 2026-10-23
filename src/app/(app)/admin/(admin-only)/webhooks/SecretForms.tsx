"use client";

import { useActionState, useState } from "react";
import { createWebhookAction, rotateWebhookSecretAction, type SecretState } from "../../_actions/webhooks";

const IDLE: SecretState = { status: "idle" };

function SecretResult({ state }: { state: SecretState }) {
  const [copied, setCopied] = useState(false);
  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm text-danger">
        {state.message}
      </p>
    );
  }
  if (state.status !== "success" || !state.secret) return null;
  return (
    <div role="status" className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
      <p className="font-semibold text-ink">{state.message}</p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="block flex-1 overflow-x-auto rounded bg-surface-alt px-3 py-2 font-mono text-xs">{state.secret}</code>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(state.secret!).then(() => setCopied(true))}
          className="h-9 rounded-lg border border-border px-3 text-sm font-semibold hover:bg-surface-alt"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function NewWebhookForm({ events, teams }: { events: { value: string; label: string }[]; teams: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createWebhookAction, IDLE);
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm sm:col-span-2">
            <span className="block font-semibold text-ink">Endpoint URL</span>
            <input name="url" type="url" required maxLength={2000} placeholder="https://example.com/webhooks/btc" className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
          </label>
          <label className="text-sm">
            <span className="block font-semibold text-ink">Description</span>
            <input name="description" maxLength={200} placeholder="For example: n8n booking flow" className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
          </label>
          <label className="text-sm">
            <span className="block font-semibold text-ink">Bookings from</span>
            <select name="teamId" defaultValue="" className="mt-1 h-10 w-full rounded-lg border border-border px-3">
              <option value="">All booking pages</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  Partner: {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="text-sm">
          <legend className="font-semibold text-ink">Events</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {events.map((e) => (
              <label key={e.value} className="flex items-center gap-2">
                <input type="checkbox" name="events" value={e.value} defaultChecked className="size-4" />
                <span>
                  {e.label} <code className="font-mono text-xs text-muted">{e.value}</code>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={pending} className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
          {pending ? "Adding…" : "Add webhook"}
        </button>
      </form>
      <SecretResult state={state} />
    </div>
  );
}

export function RotateSecretButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(rotateWebhookSecretAction, IDLE);
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <button type="submit" disabled={pending} className="h-8 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-surface-alt disabled:opacity-60">
          {pending ? "Rotating…" : "Rotate secret"}
        </button>
      </form>
      <SecretResult state={state} />
    </div>
  );
}
