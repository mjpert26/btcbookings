import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { BookingCancelledEmail } from "@/server/email/templates/booking-cancelled";
import { BookingConfirmedEmail } from "@/server/email/templates/booking-confirmed";
import { BookingReminderEmail } from "@/server/email/templates/booking-reminder";
import { BookingRescheduledEmail } from "@/server/email/templates/booking-rescheduled";
import { HostBookingNoticeEmail, hostNoticeSubject, type HostNoticeData } from "@/server/email/templates/host-booking-notice";
import {
  HostConflictFlaggedEmail,
  hostConflictSubject,
  type HostConflictData,
} from "@/server/email/templates/host-conflict-flagged";
import { inviteeSubject, type InviteeEmailData, type InviteeKind } from "@/server/email/templates/invitee";

export type RenderedEmail = { subject: string; html: string; text: string };

async function finish(subject: string, element: ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text };
}

const INVITEE_COMPONENTS: Record<InviteeKind, (d: InviteeEmailData) => ReactElement> = {
  confirmed: BookingConfirmedEmail,
  rescheduled: BookingRescheduledEmail,
  cancelled: BookingCancelledEmail,
  reminder: BookingReminderEmail,
};

export function renderInviteeEmail(kind: InviteeKind, data: InviteeEmailData): Promise<RenderedEmail> {
  return finish(inviteeSubject(kind, data).subject, INVITEE_COMPONENTS[kind](data));
}

export function renderHostNotice(data: HostNoticeData): Promise<RenderedEmail> {
  return finish(hostNoticeSubject(data).subject, HostBookingNoticeEmail(data));
}

export function renderHostConflict(data: HostConflictData): Promise<RenderedEmail> {
  return finish(hostConflictSubject(data).subject, HostConflictFlaggedEmail(data));
}
