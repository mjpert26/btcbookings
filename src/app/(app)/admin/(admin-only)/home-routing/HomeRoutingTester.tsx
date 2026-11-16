"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { InlineStatus } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { buttonClass } from "@/components/ui/Button";
import { testHomeRoutingAction, type HomeRoutingTestState } from "../../_actions/home-routing";

const DECISION: Record<string, string> = {
  owner: "Account manager (open opportunity or open lead)",
  renewal: "Renewal (funded deal or open renewal opportunity)",
  new: "New applicant (no match)",
};

const DESTINATION: Record<string, string> = {
  owner: "Account manager's booking page",
  renewal_rep: "Renewal rep's own booking page",
  renewal: "Renewal page",
  new_business: "New-business page",
  none: "No page: the visitor sees the fallback with a link to the website",
};

function lookupText(lookup: string): string {
  if (lookup === "ok") return "Salesforce answered";
  if (lookup === "no_token") return "Skipped: N8N_LOOKUP_TOKEN is not set (Admin > Settings)";
  if (lookup === "skipped") return "Skipped: daily lookup limit reached";
  return `Failed (${lookup}); treated as no match`;
}

/** Admin-only form that shows how the home page would route one email. */
export function HomeRoutingTester() {
  const [state, formAction, pending] = useActionState<HomeRoutingTestState, FormData>(testHomeRoutingAction, { status: "idle" });
  const r = state.result;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  }

  return (
    <div className="space-y-4">
      <form action={formAction} onSubmit={onSubmit} aria-label="Test an email" noValidate className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Input
          name="email"
          type="email"
          label="Visitor email"
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          required
          wrapperClassName="flex-1"
          error={state.fieldErrors?.email}
        />
        <button type="submit" aria-disabled={pending || undefined} className={buttonClass("secondary", "md")} onClick={(e) => pending && e.preventDefault()}>
          {pending ? "Looking up…" : "Test"}
        </button>
      </form>
      {state.status === "error" ? <InlineStatus state={state} /> : null}
      <div aria-live="polite">
        {r && state.status === "success" ? (
          <dl className="grid gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-alt p-4 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Salesforce lookup</dt>
            <dd>{lookupText(r.lookup)}</dd>
            <dt className="text-muted">Decision</dt>
            <dd>{DECISION[r.decision] ?? r.decision}</dd>
            {r.matchedEmail ? (
              <>
                <dt className="text-muted">{r.decision === "renewal" ? "Preferred person" : "Matched owner"}</dt>
                <dd className="break-all font-mono text-xs">{r.matchedEmail}</dd>
              </>
            ) : null}
            {r.decision === "renewal" ? (
              <>
                <dt className="text-muted">Renewal book</dt>
                <dd>{r.book ?? "None on the account"}</dd>
              </>
            ) : null}
            <dt className="text-muted">Destination</dt>
            <dd>{DESTINATION[r.destination] ?? r.destination}</dd>
            {r.repEmail ? (
              <>
                <dt className="text-muted">Books with</dt>
                <dd className="break-all font-mono text-xs">{r.repEmail}</dd>
              </>
            ) : null}
            <dt className="text-muted">Path</dt>
            <dd>
              {r.path ? (
                <a href={r.path} target="_blank" rel="noopener" className="break-all font-mono text-xs font-semibold text-primary hover:underline">
                  {r.path}
                </a>
              ) : (
                "None"
              )}
            </dd>
          </dl>
        ) : null}
      </div>
    </div>
  );
}
