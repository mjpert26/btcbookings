import { InviteeEmail, type InviteeEmailData } from "./invitee";

/**
 * Invitee notice that a booking changed: a new time (invitee reschedule) or a new host at
 * the same time (reassignment). ICS attached by the sender. Localized en/es.
 */
export function BookingRescheduledEmail(data: InviteeEmailData) {
  return <InviteeEmail kind="rescheduled" data={data} />;
}
