import { InviteeEmail, type InviteeEmailData } from "./invitee";

/** Invitee confirmation for a new booking (ICS attached by the sender). Localized en/es. */
export function BookingConfirmedEmail(data: InviteeEmailData) {
  return <InviteeEmail kind="confirmed" data={data} />;
}
