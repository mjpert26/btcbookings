import "server-only";
import { DateTime } from "luxon";
import { service, type Db } from "@/server/db/client";
import { SF_LEAD_MODES, type SfLeadMode } from "@/lib/salesforce";

export { SF_LEAD_MODES, type SfLeadMode };

/**
 * Salesforce lead settings: resolution of the effective settings row for an event type
 * (variants inherit from their parent) and the pure mapping from a booking to the payload
 * sent to the n8n lead workflow. The payload contract is documented in
 * docs/n8n-workflows.md ("Salesforce leads").
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
  lead_mode: SfLeadMode;
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
  "lead_mode",
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
  /** Lead handling (event_type_sf_settings.lead_mode). n8n treats a reschedule as update only. */
  mode: SfLeadMode;
  /** True for the job of a rescheduled booking. Same value as meeting.isReschedule. */
  isReschedule: boolean;
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
    isReschedule: boolean;
  };
  options: { createTask: boolean; createNote: boolean; setMeetingBookedFields: boolean };
  /** The invitee's answer to a notes-style question, for the Meeting Booked note. */
  noteText: string | null;
  /** "Source" line of the Meeting Booked note. */
  sourceLabel: string;
  /** Number for text messages: the invitee's phone. */
  mobilePhone: string | null;
  /** Partner display name, when the page belongs to a partner team and an ISO is set. */
  isoName: string | null;
  source: "btc-scheduler";
};

/** Question metadata used to pick the note text. Rows come from app.event_type_questions. */
export type NoteQuestion = {
  key: string;
  type: string | null;
  label: Record<string, string> | null;
  position: number | null;
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
  /** Metadata of the answered questions (labels, types, order). Optional. */
  questions?: NoteQuestion[];
  /** The partner (team) the page belongs to, or null for an individual page. */
  partner?: { displayName: string } | null;
  /** True for the job of a rescheduled booking. */
  isReschedule?: boolean;
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
    | "lead_mode"
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

/**
 * Text fragments that mark a notes question, matched case-insensitively against the question
 * key (underscores read as spaces) and its English label. Same list as the Calendly lead flow.
 */
export const NOTE_QUESTION_PATTERNS = ["help prepare", "anything that will help", "additional", "notes"] as const;
const NOTE_TEXT_MAX = 5000;

function isNoteQuestion(key: string, label: string | null | undefined): boolean {
  const texts = [key.replace(/_/g, " ").toLowerCase(), (label ?? "").toLowerCase()];
  return NOTE_QUESTION_PATTERNS.some((p) => texts.some((t) => t.includes(p)));
}

/**
 * The answer to the first notes-style question, in question order. Questions are matched by
 * key or English label (NOTE_QUESTION_PATTERNS). Checkbox, dropdown, email and phone
 * questions are ignored. Answers whose question no longer exists are matched by key only,
 * after the known questions. Returns null when nothing matches.
 */
export function selectNoteText(answers: Record<string, string>, questions: NoteQuestion[] = []): string | null {
  const FREE_TEXT = new Set(["text", "textarea"]);
  const byKey = new Map(questions.map((q) => [q.key, q]));
  const ordered = [...questions]
    .filter((q) => Object.hasOwn(answers, q.key))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.key.localeCompare(b.key))
    .map((q) => q.key);
  const orphans = Object.keys(answers)
    .filter((k) => !byKey.has(k))
    .sort();
  for (const key of [...ordered, ...orphans]) {
    const q = byKey.get(key);
    if (q && q.type && !FREE_TEXT.has(q.type)) continue;
    const raw = answers[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    if (isNoteQuestion(key, q?.label?.en)) return value.slice(0, NOTE_TEXT_MAX);
  }
  return null;
}

/**
 * "Source" line of the Meeting Booked note: "<partner display name> BTC Scheduler" for a
 * partner (team) page, "BTC Scheduler - <event type name>" otherwise.
 */
export function buildSourceLabel(input: { partnerName?: string | null; eventTypeName: string }): string {
  const partner = input.partnerName?.trim();
  return partner ? `${partner} BTC Scheduler` : `BTC Scheduler - ${input.eventTypeName.trim()}`;
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
  if (!(SF_LEAD_MODES as readonly string[]).includes(settings.lead_mode)) {
    throw new SfSettingsError(`Unknown lead mode: ${JSON.stringify(settings.lead_mode)}`);
  }
  // The Meeting Booked writer needs the assigned host (Task owner, note agent, rep lookup).
  if (settings.lead_mode !== "create" && !input.host?.email) {
    throw new SfSettingsError("Updating an existing Lead needs the booking's assigned host");
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

  const isReschedule = input.isReschedule === true;
  const iso = lead.get(ISO_FIELD.toLowerCase())?.value;
  const partnerName = input.partner?.displayName?.trim() || null;

  const payload: LeadPayload = {
    idempotencyKey: booking.id,
    bookingId: booking.id,
    mode: settings.lead_mode,
    isReschedule,
    lead: Object.fromEntries([...lead.values()].map((e) => [e.field, e.value])),
    owner,
    autoAssign: settings.owner_mode === "assignment_rules",
    meeting: {
      startUtc,
      endUtc,
      eventTypeName: input.eventTypeName,
      hostEmail: input.host?.email ?? null,
      hostName: input.host?.name ?? null,
      isReschedule,
    },
    options: {
      createTask: settings.create_task,
      createNote: settings.create_note,
      setMeetingBookedFields: settings.set_meeting_booked_fields,
    },
    noteText: selectNoteText(input.answers, input.questions),
    sourceLabel: buildSourceLabel({ partnerName, eventTypeName: input.eventTypeName }),
    mobilePhone: builtins.invitee_phone,
    isoName: partnerName && typeof iso === "string" && iso ? partnerName : null,
    source: "btc-scheduler",
  };
  if (settings.campaign_id) payload.campaignId = settings.campaign_id;
  return payload;
}
