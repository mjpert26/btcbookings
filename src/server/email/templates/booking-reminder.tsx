import { InviteeEmail, type InviteeEmailData } from "./invitee";

/** Invitee reminder sent at start minus each configured offset. Localized en/es. */
export function BookingReminderEmail(data: InviteeEmailData) {
  return <InviteeEmail kind="reminder" data={data} />;
}
