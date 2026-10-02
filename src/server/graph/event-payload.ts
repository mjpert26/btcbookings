import { DateTime } from "luxon";

/**
 * Builds the Outlook event body for a booking. Pure: no I/O, so it is unit-tested directly.
 */
export const BOOKING_PROPERTY_ID = "String {66f5a359-4659-4638-81a3-d1d2b2f5c5b4} Name BtcBookingId";

export type LocationType = "teams" | "phone" | "in_person" | "custom";

export type EventPayloadInput = {
  bookingId: string;
  eventTypeName: string;
  startAt: Date;
  endAt: Date;
  invitee: { name: string; email: string; phone: string | null; timezone: string };
  locationType: LocationType;
  locationDetail: string | null;
  /** Other hosts added as required attendees (collective events). */
  coHosts: { name: string; email: string }[];
  answers: { label: string; value: string }[];
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function utc(d: Date): { dateTime: string; timeZone: string } {
  return { dateTime: DateTime.fromJSDate(d, { zone: "UTC" }).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone: "UTC" };
}

function locationDisplay(i: EventPayloadInput): string {
  switch (i.locationType) {
    case "teams":
      return "Microsoft Teams Meeting";
    case "phone":
      return i.invitee.phone ? `Phone: ${i.invitee.phone}` : i.locationDetail ? `Phone: ${i.locationDetail}` : "Phone call";
    case "in_person":
    case "custom":
      return i.locationDetail ?? "";
  }
}

/** Placeholder replaced by the booking module once manage links are rendered into the body. */
export const MANAGE_LINK_PLACEHOLDER = "<!-- btc-manage-link -->";

export function buildEventBody(i: EventPayloadInput): string {
  const rows = [
    ["Invitee", i.invitee.name],
    ["Email", i.invitee.email],
    ...(i.invitee.phone ? [["Phone", i.invitee.phone]] : []),
    ["Invitee time zone", i.invitee.timezone],
    ...i.answers.map((a) => [a.label, a.value]),
  ];
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0"><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  return [
    `<p>${escapeHtml(i.eventTypeName)} booked through BTC Scheduler.</p>`,
    `<table>${table}</table>`,
    `<p>${MANAGE_LINK_PLACEHOLDER}Need to make a change? Use the reschedule or cancel link in the confirmation email.</p>`,
  ].join("\n");
}

type Attendee = { emailAddress: { address: string; name: string }; type: "required" };

export type EventPayload = {
  subject: string;
  body: { contentType: "HTML"; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location: { displayName: string };
  attendees: Attendee[];
  showAs: "busy";
  allowNewTimeProposals: boolean;
  singleValueExtendedProperties: { id: string; value: string }[];
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: "teamsForBusiness";
  transactionId?: string;
};

/** Payload for POST /me/events. */
export function buildCreatePayload(i: EventPayloadInput): EventPayload {
  return { ...buildUpdatePayload(i), ...onlineMeetingFields(i), transactionId: i.bookingId };
}

/**
 * Payload for PATCH /me/events/{id}. onlineMeetingProvider is omitted: Graph does not allow
 * changing it (or turning the online meeting off) once the meeting is online.
 */
export function buildUpdatePayload(i: EventPayloadInput): EventPayload {
  const display = locationDisplay(i);
  return {
    subject: `${i.eventTypeName}: ${i.invitee.name}`,
    body: { contentType: "HTML", content: buildEventBody(i) },
    start: utc(i.startAt),
    end: utc(i.endAt),
    location: { displayName: display },
    attendees: [
      { emailAddress: { address: i.invitee.email, name: i.invitee.name }, type: "required" },
      ...i.coHosts.map((h): Attendee => ({ emailAddress: { address: h.email, name: h.name }, type: "required" })),
    ],
    showAs: "busy",
    allowNewTimeProposals: false,
    singleValueExtendedProperties: [{ id: BOOKING_PROPERTY_ID, value: i.bookingId }],
  };
}

function onlineMeetingFields(i: EventPayloadInput): Pick<EventPayload, "isOnlineMeeting" | "onlineMeetingProvider"> {
  return i.locationType === "teams" ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {};
}
