"use client";

import { Dialog, DialogCloseButton } from "@/components/ui/Dialog";
import { ActionForm } from "@/components/ui/Form";
import { Textarea } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cancelBookingAction } from "@/app/(app)/bookings/_actions";

export function CancelBooking({ bookingId, inviteeName }: { bookingId: string; inviteeName: string }) {
  return (
    <Dialog
      trigger="Cancel booking"
      triggerVariant="danger"
      title="Cancel this booking?"
      description={`${inviteeName} will receive a cancellation email and the Outlook event will be removed.`}
    >
      <ActionForm action={cancelBookingAction} className="space-y-4">
        <input type="hidden" name="bookingId" value={bookingId} />
        <Textarea label="Reason (optional)" name="reason" maxLength={500} hint="Included in the cancellation email." />
        <div className="flex justify-end gap-2">
          <DialogCloseButton>Keep booking</DialogCloseButton>
          <SubmitButton variant="danger" pendingLabel="Cancelling…">
            Cancel booking
          </SubmitButton>
        </div>
      </ActionForm>
    </Dialog>
  );
}
