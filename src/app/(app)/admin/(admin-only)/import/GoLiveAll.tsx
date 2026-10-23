"use client";

import { Dialog, DialogCloseButton } from "@/components/ui/Dialog";
import { ActionForm } from "@/components/ui/Form";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { goLiveImportedAction } from "../../_actions/import";

/** "Take everything live" behind a confirmation, because it opens every eligible page at once. */
export function GoLiveAll({ ready, notConnected }: { ready: number; notConnected: number }) {
  return (
    <Dialog
      trigger="Take everything live"
      triggerVariant="primary"
      triggerSize="sm"
      title={`Take ${ready} imported page${ready === 1 ? "" : "s"} live?`}
      description={
        notConnected
          ? `${notConnected} of these pages belong to reps or teams without a connected Outlook calendar. They show no times until their reps sign in. Old Calendly links keep working, so the same rep can be booked in both systems.`
          : "Old Calendly links keep working, so the same rep can be booked in both systems."
      }
    >
      <ActionForm action={goLiveImportedAction} className="flex justify-end gap-2">
        <input type="hidden" name="kind" value="all" />
        <DialogCloseButton>Not yet</DialogCloseButton>
        <SubmitButton variant="primary" pendingLabel="Working…">
          Take everything live
        </SubmitButton>
      </ActionForm>
    </Dialog>
  );
}
