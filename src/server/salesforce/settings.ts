import "server-only";
import { DateTime } from "luxon";
import { service, type Db } from "@/server/db/client";

/**
 * Salesforce lead settings: resolution of the effective settings row for an event type
 * (variants inherit from their parent) and the pure mapping from a booking to the payload
 * sent to the n8n lead workflow. The payload contract is documented in
 * docs/n8n-workflows.md ("Salesforce lead creation").
 */

export type SfOwnerMode = "assigned_host" | "fixed" | "assignment_rules";
export type StaticValue = string | number | boolean | null;

export type SfSettingsRow = {
  event_type_id: string;
  create_sf_lead: boolean;
  field_mapping: Record<string, string>;
  static_values: Record<string, StaticValue>;
  campaign_id: string | null;
  owner_mode: SfOwnerMode;
  owner_fixed_id: string | null;
  create_task: boolean;
  create_note: boolean;
  set_meeting_booked_fields: boolean;
  updated_by: string | null;
  updated_at: Date;
};

export type SfSettingsProvenance = "own" | "inherited" | "none";

export type EffectiveSfSettings = {
  settings: SfSettingsRow | null;
  provenance: SfSettingsProvenance;
  /** Event type whose row supplied the settings (the parent when inherited). */
  sourceEventTypeId: string | null;
};

export const SF_SETTINGS_OVERRIDE_KEY = "sf_settings";
export const ISO_FIELD = "csbs__ISO__c";
export const SF_TIMEZONE = "America/New_York";

export const SF_SETTINGS_COLUMNS = [
  "event_type_id",
  "create_sf_lead",
  "field_mapping",
  "static_values",
  "campaign_id",
  "owner_mode",
  "owner_fixed_id",
  "create_task",
  "create_note",
  "set_meeting_booked_fields",
  "updated_by",
  "updated_at",
] as const;

/**
 * Returns the settings that apply to an event type. A variant (parent_event_type_id set)
 * uses its parent's row unless "sf_settings" is listed in its overrides. Uses the service
 * connection by default; pass a transaction to read inside one.
 */
export async function getEffectiveSfSettings(eventTypeId: string, db: Db = service()): Promise<EffectiveSfSettings> {
  const [et] = await db<{ id: string; parent_event_type_id: string | null; overrides: string[] }[]>`
    select id, parent_event_type_id, overrides from app.event_types where id = ${eventTypeId}
  `;
  if (!et) return { settings: null, provenance: "none", sourceEventTypeId: null };
  const inherits = et.parent_event_type_id !== null && !et.overrides.includes(SF_SETTINGS_OVERRIDE_KEY);
  const sourceId = inherits ? et.parent_event_type_id! : et.id;
  const [row] = await db<SfSettingsRow[]>`
    select ${db(SF_SETTINGS_COLUMNS as unknown as string[])} from app.event_type_sf_settings where event_type_id = ${sourceId}
  `;
  if (!row) return { settings: null, provenance: "none", sourceEventTypeId: null };
  return { settings: row, provenance: inherits ? "inherited" : "own", sourceEventTypeId: sourceId };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export class SfSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfSettingsError";
  }
}

const FIELD_API_NAME = /^[A-Za-z][A-Za-z0-9_]*(__c)?$/;
const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const QUESTION_SOURCE = /^q:[a-z][a-z0-9_]{0,62}$/;

/** Lead fields that the mapping and static values may not write. Owner is set by owner mode. */
const FORBIDDEN_LEAD_FIELDS = new Set(
  [
    "Id",
    "OwnerId",
    "Name",
    "IsDeleted",
    "IsConverted",
    "MasterRecordId",
    "CreatedById",
    "CreatedDate",
    "LastModifiedById",
    "LastModifiedDate",
    "SystemModstamp",
  ].map((f) => f.toLowerCase()),
);

export function isValidFieldApiName(name: string): boolean {
  return name.length <= 80 && FIELD_API_NAME.test(name) && !name.includes("___") && !name.endsWith("_");
}

/** Validates a Lead field API name for use as a mapping target or static value key. */
export function assertWritableLeadField(name: string): void {
  if (!isValidFieldApiName(name)) throw new SfSettingsError(`Invalid Salesforce field API name: ${JSON.stringify(name)}`);
  if (FORBIDDEN_LEAD_FIELDS.has(name.toLowerCase())) throw new SfSettingsError(`Field ${name} cannot be set by mapping or static values`);
}

/** True for a 15 or 18 character Salesforce Id, optionally with one of the given key prefixes. */
export function isSalesforceId(value: unknown, prefixes?: string[]): value is string {
  if (typeof value !== "string" || !SF_ID.test(value)) return false;
  return !prefixes || prefixes.some((p) => value.startsWith(p));
}

export const ID_PREFIX = {
  lead: "00Q",
  account: "001",
  user: "005",
  queue: "00G",
  campaign: "701",
} as const;

/** Source keys available to field_mapping besides "q:<question_key>". */
export const BUILTIN_SOURCES = [
  "invitee_name",
  "invitee_first_name",
  "invitee_last_name",
  "invitee_email",
  "invitee_phone",
  "invitee_timezone",
  "booking_id",
  "booking_start",
  "booking_end",
  "booking_start_local",
  "event_type_name",
  "language",
  "language_name",
  "assigned_host_email",
  "assigned_host_name",
] as const;
export type BuiltinSource = (typeof BUILTIN_SOURCES)[number];
const BUILTIN_SET = new Set<string>(BUILTIN_SOURCES);

export function isValidSourceKey(key: string): boolean {
  return BUILTIN_SET.has(key) || QUESTION_SOURCE.test(key);
}

/** Validates a full mapping: known sources, writable targets, no target mapped twice. */
export function validateFieldMapping(mapping: Record<string, string>): void {
  const targets = new Set<string>();
  for (const [source, target] of Object.entries(mapping)) {
    if (!isValidSourceKey(source)) throw new SfSettingsError(`Unknown mapping source: ${JSON.stringify(source)}`);
    if (typeof target !== "string") throw new SfSettingsError(`Mapping target for ${source} must be a field name`);
    assertWritableLeadField(target);
    const lower = target.toLowerCase();
    if (targets.has(lower)) throw new SfSettingsError(`Field ${target} is mapped more than once`);
    targets.add(lower);
  }
}

export function validateStaticValues(values: Record<string, StaticValue>): void {
  for (const [field, value] of Object.entries(values)) {
    assertWritableLeadField(field);
    const t = value === null ? "null" : typeof value;
    if (!["string", "number", "boolean", "null"].includes(t)) throw new SfSettingsError(`Static value for ${field} must be a scalar`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new SfSettingsError(`Static value for ${field} must be finite`);
  }
  const iso = values[ISO_FIELD];
  if (iso !== undefined && iso !== null && !isSalesforceId(iso, [ID_PREFIX.account])) {
    throw new SfSettingsError(`${ISO_FIELD} must be an Account Id (001...)`);
  }
}

export function validateOwner(mode: SfOwnerMode, fixedId: string | null): void {
  if (mode === "fixed" && !isSalesforceId(fixedId, [ID_PREFIX.user, ID_PREFIX.queue])) {
    throw new SfSettingsError("Fixed owner must be a User (005...) or Queue (00G...) Id");
  }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export type LeadOwner =
  | { mode: "assigned_host"; ownerEmail: string }
  | { mode: "fixed"; ownerId: string }
  | { mode: "assignment_rules" };

export type LeadPayload = {
  idempotencyKey: string;
  bookingId: string;
  lead: Record<string, StaticValue>;
  owner: LeadOwner;
  autoAssign: boolean;
  campaignId?: string;
  meeting: {
    startUtc: string;
    endUtc: string;
    eventTypeName: string;
    hostEmail: string | null;
    hostName: string | null;
    isReschedule: false;
  };
  options: { createTask: boolean; createNote: boolean; setMeetingBookedFields: boolean };
  source: "btc-scheduler";
};

export type LeadBuildInput = {
  booking: {
    id: string;
    startAt: Date | string;
    endAt: Date | string;
    inviteeName: string;
    inviteeEmail: string;
    inviteePhone: string | null;
    inviteeTimezone: string | null;
    language: string;
  };
  eventTypeName: string;
  /** Primary assigned host (the round-robin pick, or the owner for individual pages). */
  host: { email: string; name: string } | null;
  /** question_key -> answer value */
  answers: Record<string, string>;
  settings: Pick<
    SfSettingsRow,
    | "field_mapping"
    | "static_values"
    | "campaign_id"
    | "owner_mode"
    | "owner_fixed_id"
    | "create_task"
    | "create_note"
    | "set_meeting_booked_fields"
  >;
};

/** Lead field length limits enforced by Salesforce for the standard fields set by default. */
const FIELD_LIMITS: Record<string, number> = { firstname: 40, lastname: 80, company: 255, email: 80, phone: 40 };
const COMPANY_QUESTION_KEYS = ["company", "company_name", "business_name", "business"];
const LANGUAGE_NAMES: Record<string, string> = { en: "English", es: "Spanish" };

/**
 * Splits a full name into FirstName and LastName. The first word is the first name and the
 * remainder is the last name, which keeps compound Spanish surnames ("Garcia Lopez")
 * together. A single word becomes the LastName, which Salesforce requires.
 */
export function splitName(full: string): { firstName: string | null; lastName: string } {
  const words = full.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { firstName: null, lastName: "Unknown" };
  if (words.length === 1) return { firstName: null, lastName: words[0] };
  return { firstName: words[0], lastName: words.slice(1).join(" ") };
}

function toUtcIso(value: Date | string): string {
  const dt = typeof value === "string" ? DateTime.fromISO(value, { zone: "utc" }) : DateTime.fromJSDate(value, { zone: "utc" });
  if (!dt.isValid) throw new SfSettingsError("Invalid booking time");
  return dt.toUTC().toISO({ suppressMilliseconds: true })!;
}

function truncate(field: string, value: StaticValue): StaticValue {
  const limit = FIELD_LIMITS[field.toLowerCase()];
  return typeof value === "string" && limit && value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Builds the n8n lead payload. Precedence for each Lead field, lowest to highest:
 *   1. defaults (FirstName/LastName from invitee_name, Email, Phone),
 *   2. field_mapping values,
 *   3. static_values (an admin's fixed value always wins over a mapped answer).
 * Company falls back to a company-like question answer, then "Unknown".
 * Empty mapped values are skipped so they never blank a static or default value.
 */
export function buildLeadPayload(input: LeadBuildInput): LeadPayload {
  const { booking, settings } = input;
  validateFieldMapping(settings.field_mapping);
  validateStaticValues(settings.static_values);
  validateOwner(settings.owner_mode, settings.owner_fixed_id);
  if (settings.campaign_id && !isSalesforceId(settings.campaign_id, [ID_PREFIX.campaign])) {
    throw new SfSettingsError("Campaign Id must start with 701");
  }

  const startUtc = toUtcIso(booking.startAt);
  const endUtc = toUtcIso(booking.endAt);
  const name = splitName(booking.inviteeName);
  const lang = booking.language.toLowerCase();

  const builtins: Record<BuiltinSource, string | null> = {
    invitee_name: booking.inviteeName.trim().replace(/\s+/g, " "),
    invitee_first_name: name.firstName,
    invitee_last_name: name.lastName,
    invitee_email: booking.inviteeEmail.trim(),
    invitee_phone: booking.inviteePhone?.trim() || null,
    invitee_timezone: booking.inviteeTimezone,
    booking_id: booking.id,
    booking_start: startUtc,
    booking_end: endUtc,
    booking_start_local: DateTime.fromISO(startUtc).setZone(SF_TIMEZONE).toFormat("ccc, MM/dd/yyyy, hh:mm a ZZZZ"),
    event_type_name: input.eventTypeName,
    language: lang,
    language_name: LANGUAGE_NAMES[lang] ?? lang,
    assigned_host_email: input.host?.email ?? null,
    assigned_host_name: input.host?.name ?? null,
  };

  // Case-insensitive field keys so "email" and "Email" never produce two entries.
  const lead = new Map<string, { field: string; value: StaticValue }>();
  const set = (field: string, value: StaticValue) => lead.set(field.toLowerCase(), { field, value: truncate(field, value) });

  if (name.firstName) set("FirstName", name.firstName);
  set("LastName", name.lastName);
  set("Email", builtins.invitee_email);
  if (builtins.invitee_phone) set("Phone", builtins.invitee_phone);

  for (const [source, field] of Object.entries(settings.field_mapping)) {
    const value = source.startsWith("q:") ? input.answers[source.slice(2)] : builtins[source as BuiltinSource];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    set(field, String(value).trim());
  }
  for (const [field, value] of Object.entries(settings.static_values)) {
    if (value === null || value === "") continue;
    set(field, value);
  }

  if (!lead.has("company")) {
    const key = COMPANY_QUESTION_KEYS.find((k) => input.answers[k]?.trim());
    set("Company", key ? input.answers[key].trim() : "Unknown");
  }
  const last = lead.get("lastname");
  if (!last || last.value === null || String(last.value).trim() === "") set("LastName", "Unknown");

  let owner: LeadOwner;
  switch (settings.owner_mode) {
    case "assigned_host":
      if (!input.host?.email) throw new SfSettingsError("Owner mode is assigned_host but the booking has no assigned host");
      owner = { mode: "assigned_host", ownerEmail: input.host.email };
      break;
    case "fixed":
      owner = { mode: "fixed", ownerId: settings.owner_fixed_id! };
      break;
    case "assignment_rules":
      owner = { mode: "assignment_rules" };
      break;
  }

  const payload: LeadPayload = {
    idempotencyKey: booking.id,
    bookingId: booking.id,
    lead: Object.fromEntries([...lead.values()].map((e) => [e.field, e.value])),
    owner,
    autoAssign: settings.owner_mode === "assignment_rules",
    meeting: {
      startUtc,
      endUtc,
      eventTypeName: input.eventTypeName,
      hostEmail: input.host?.email ?? null,
      hostName: input.host?.name ?? null,
      isReschedule: false,
    },
    options: {
      createTask: settings.create_task,
      createNote: settings.create_note,
      setMeetingBookedFields: settings.set_meeting_booked_fields,
    },
    source: "btc-scheduler",
  };
  if (settings.campaign_id) payload.campaignId = settings.campaign_id;
  return payload;
}
