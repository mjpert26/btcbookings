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

/**
 * What the n8n lead workflow does with a booking (event_type_sf_settings.lead_mode).
 * match_or_create and update_only follow the Calendly "create" and "update" mappings.
 */
export const SF_LEAD_MODES = ["match_or_create", "update_only", "create"] as const;
export type SfLeadMode = (typeof SF_LEAD_MODES)[number];

/** Default for new settings rows. */
export const DEFAULT_SF_LEAD_MODE: SfLeadMode = "match_or_create";

export const SF_LEAD_MODE_OPTIONS: readonly { value: SfLeadMode; label: string; short: string; hint: string }[] = [
  {
    value: "match_or_create",
    label: "Update the invitee's Lead, or create one",
    short: "Update or create",
    hint: "Finds the open Lead with the invitee's email and marks it Meeting Booked. A converted Lead is left alone. When no Lead exists, a new one is created. Reschedules update the Lead.",
  },
  {
    value: "update_only",
    label: "Update the invitee's Lead only",
    short: "Update only",
    hint: "Marks the open Lead with the invitee's email as Meeting Booked. Never creates a Lead; bookings without a matching open Lead are skipped. Reschedules update the Lead.",
  },
  {
    value: "create",
    label: "Always create a new Lead",
    short: "Always create",
    hint: "The original behavior: every booking inserts a new Lead, which Salesforce duplicate rules may reject. Reschedules do not update Salesforce.",
  },
];
