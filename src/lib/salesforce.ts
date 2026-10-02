/** Lead mapping sources available to every event type, in display order. */
export const SF_BUILTIN_SOURCES = [
  { value: "invitee_name", label: "Invitee full name" },
  { value: "invitee_first_name", label: "Invitee first name" },
  { value: "invitee_last_name", label: "Invitee last name" },
  { value: "invitee_email", label: "Invitee email" },
  { value: "invitee_phone", label: "Invitee phone" },
  { value: "booking_start", label: "Booking start (UTC, ISO 8601)" },
  { value: "booking_start_local", label: "Booking start (invitee's time zone)" },
  { value: "event_type_name", label: "Event type name" },
  { value: "language", label: "Booking language" },
  { value: "assigned_host_email", label: "Assigned host email" },
  { value: "assigned_host_name", label: "Assigned host name" },
  { value: "booking_id", label: "Booking ID" },
] as const;

/** The ISO ("lead source") lookup on Lead. Stored in static_values and edited with its own field. */
export const ISO_FIELD = "csbs__ISO__c";
