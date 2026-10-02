"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";

/** Shown when a page or server action in the internal app fails unexpectedly. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-brand border border-danger/30 bg-surface p-8 text-center shadow-sm">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">The request could not be completed. Nothing was changed unless you saw a confirmation. Try again, and contact support if it keeps happening.</p>
      {error.digest ? <p className="mt-2 font-mono text-xs text-muted">Reference: {error.digest}</p> : null}
      <div className="mt-6 flex justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <ButtonLink href="/dashboard" variant="secondary">
          Go to dashboard
        </ButtonLink>
      </div>
    </div>
  );
}
