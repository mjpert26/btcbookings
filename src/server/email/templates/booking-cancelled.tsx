import { InviteeEmail, type InviteeEmailData } from "./invitee";

/** Invitee notice that a booking was cancelled. Localized en/es. */
export function BookingCancelledEmail(data: InviteeEmailData) {
  return <InviteeEmail kind="cancelled" data={data} />;
}
