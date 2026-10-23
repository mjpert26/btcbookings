"use client";

import { useActionState } from "react";
import { importCalendlyAction, type ImportState } from "../../_actions/import";
import { Badge } from "@/components/ui/Badge";

const IDLE: ImportState = { status: "idle" };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-alt px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

export function ImportForm() {
  const [state, action, pending] = useActionState(importCalendlyAction, IDLE);
  const r = state.report;
  return (
    <div className="space-y-6">
      <form action={action} className="space-y-4">
        <div>
          <label htmlFor="snapshot" className="block text-sm font-semibold text-ink">
            Calendly snapshot (JSON)
          </label>
          <input id="snapshot" name="snapshot" type="file" accept="application/json,.json" required className="mt-2 block w-full text-sm" />
        </div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="apply" className="mt-0.5 h-5 w-5 rounded border-border accent-[var(--btc-primary)]" />
          <span>
            <span className="font-semibold">Apply the import</span>
            <span className="block text-muted">Leave unchecked for a dry run that shows what would change without saving anything.</span>
          </span>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? "Running…" : "Run import"}
        </button>
      </form>

      {state.status !== "idle" ? (
        <div role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-sm text-danger" : "text-sm text-success"}>
          {state.message}
        </div>
      ) : null}

      {r ? (
        <section aria-labelledby="import-report" className="space-y-4">
          <h2 id="import-report" className="flex items-center gap-2 text-lg font-bold">
            Report {r.applied ? <Badge tone="success">Applied</Badge> : <Badge>Dry run</Badge>}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Users" value={`${r.users.created} new (${r.users.schedulesImported} with Calendly hours), ${r.users.existing} existing`} />
            <Stat label="Teams" value={`${r.teams.created} new, ${r.teams.existing} existing, ${r.teamMembers.added} members added`} />
            <Stat
              label="Booking pages"
              value={`${r.eventTypes.created} new (inactive, ${r.eventTypes.goLiveEligible} ready to go live), ${r.eventTypes.existing} existing, ${r.eventTypes.skipped} skipped`}
            />
            <Stat label="Bookings" value={`${r.bookings.created} new, ${r.bookings.updated} moved, ${r.bookings.reassigned} reassigned`} />
            <Stat label="Cancelled in Calendly" value={`${r.bookings.cancelled} cancelled, ${r.bookings.cancelledMissing} no longer listed`} />
            <Stat label="Bookings (other)" value={`${r.bookings.unchanged} unchanged, ${r.bookings.flagged} flagged, ${r.bookings.skipped} skipped`} />
            <Stat label="Time" value={`${(r.elapsedMs / 1000).toFixed(1)} s`} />
          </div>
          {r.warnings.length ? (
            <details className="rounded-lg border border-border bg-surface p-4 text-sm">
              <summary className="cursor-pointer font-semibold">{r.warnings.length} warnings</summary>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-muted">
                {r.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
