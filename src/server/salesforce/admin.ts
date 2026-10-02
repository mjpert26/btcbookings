import "server-only";
import { z } from "zod";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { env } from "@/server/env";
import {
  getEffectiveSfSettings,
  ID_PREFIX,
  isSalesforceId,
  ISO_FIELD,
  SF_SETTINGS_COLUMNS,
  SF_SETTINGS_OVERRIDE_KEY,
  SfSettingsError,
  validateFieldMapping,
  validateOwner,
  validateStaticValues,
  type SfOwnerMode,
  type SfSettingsProvenance,
  type SfSettingsRow,
  type StaticValue,
} from "@/server/salesforce/settings";

/**
 * Admin server functions for Salesforce lead settings and the lead outbox. Every function
 * runs as the signed-in user under RLS (withUser) and additionally requires the admin role.
 * Changes are audited in the same transaction.
 */

export type Actor = { id: string };

export class ForbiddenError extends Error {
  constructor(message = "Admin access required") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

async function assertAdmin(tx: Tx): Promise<void> {
  const [r] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!r?.ok) throw new ForbiddenError();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type SfSettingsDto = {
  eventTypeId: string;
  createSfLead: boolean;
  /** Lead source in BTC terms: the ISO Account (csbs__ISO__c). */
  isoAccountId: string | null;
  fieldMapping: Record<string, string>;
  /** Static Lead values other than csbs__ISO__c (for example the standard LeadSource picklist). */
  staticValues: Record<string, StaticValue>;
  campaignId: string | null;
  ownerMode: SfOwnerMode;
  ownerFixedId: string | null;
  createTask: boolean;
  createNote: boolean;
  setMeetingBookedFields: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type SfSettingsView = {
  eventTypeId: string;
  parentEventTypeId: string | null;
  isVariant: boolean;
  /** True when a variant lists sf_settings in its overrides (uses its own row). */
  overridesParent: boolean;
  own: SfSettingsDto | null;
  parent: SfSettingsDto | null;
  effective: SfSettingsDto | null;
  provenance: SfSettingsProvenance;
};

function toDto(row: SfSettingsRow | null | undefined): SfSettingsDto | null {
  if (!row) return null;
  const { [ISO_FIELD]: iso, ...rest } = row.static_values ?? {};
  return {
    eventTypeId: row.event_type_id,
    createSfLead: row.create_sf_lead,
    isoAccountId: typeof iso === "string" ? iso : null,
    fieldMapping: row.field_mapping ?? {},
    staticValues: rest,
    campaignId: row.campaign_id,
    ownerMode: row.owner_mode,
    ownerFixedId: row.owner_fixed_id,
    createTask: row.create_task,
    createNote: row.create_note,
    setMeetingBookedFields: row.set_meeting_booked_fields,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function loadEventType(tx: Tx, eventTypeId: string) {
  const [et] = await tx<{ id: string; parent_event_type_id: string | null; overrides: string[] }[]>`
    select id, parent_event_type_id, overrides from app.event_types where id = ${eventTypeId}
  `;
  if (!et) throw new NotFoundError("Event type not found");
  return et;
}

async function loadRow(tx: Tx, eventTypeId: string | null): Promise<SfSettingsRow | null> {
  if (!eventTypeId) return null;
  const [row] = await tx<SfSettingsRow[]>`
    select ${tx(SF_SETTINGS_COLUMNS as unknown as string[])} from app.event_type_sf_settings where event_type_id = ${eventTypeId}
  `;
  return row ?? null;
}

async function readView(tx: Tx, eventTypeId: string): Promise<SfSettingsView> {
  const et = await loadEventType(tx, eventTypeId);
  const own = await loadRow(tx, et.id);
  const parent = await loadRow(tx, et.parent_event_type_id);
  const eff = await getEffectiveSfSettings(et.id, tx);
  return {
    eventTypeId: et.id,
    parentEventTypeId: et.parent_event_type_id,
    isVariant: et.parent_event_type_id !== null,
    overridesParent: et.overrides.includes(SF_SETTINGS_OVERRIDE_KEY),
    own: toDto(own),
    parent: toDto(parent),
    effective: toDto(eff.settings),
    provenance: eff.provenance,
  };
}

export async function getSfSettings(actor: Actor, eventTypeId: string): Promise<SfSettingsView> {
  z.string().uuid().parse(eventTypeId);
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    return readView(tx, eventTypeId);
  });
}

const optionalId = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

export const sfSettingsInputSchema = z
  .object({
    createSfLead: z.boolean(),
    isoAccountId: optionalId.refine((v) => v === null || isSalesforceId(v, [ID_PREFIX.account]), {
      message: "ISO must be an Account Id (001...)",
    }),
    fieldMapping: z.record(z.string().max(80), z.string().max(80)).default({}),
    staticValues: z
      .record(z.string().max(80), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
      .default({}),
    campaignId: optionalId.refine((v) => v === null || isSalesforceId(v, [ID_PREFIX.campaign]), {
      message: "Campaign Id must start with 701",
    }),
    ownerMode: z.enum(["assigned_host", "fixed", "assignment_rules"]),
    ownerFixedId: optionalId,
    createTask: z.boolean().default(false),
    createNote: z.boolean().default(false),
    setMeetingBookedFields: z.boolean().default(false),
    /** Variants only: true uses the variant's own row, false inherits the parent's. */
    overrideParent: z.boolean().optional(),
  })
  .strict();
export type SfSettingsInput = z.input<typeof sfSettingsInputSchema>;

export class SfSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfSettingsValidationError";
  }
}

function normalizeInput(raw: SfSettingsInput) {
  const parsed = sfSettingsInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SfSettingsValidationError(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  }
  const input = parsed.data;
  if (Object.keys(input.staticValues).some((k) => k.toLowerCase() === ISO_FIELD.toLowerCase())) {
    throw new SfSettingsValidationError(`Set the ISO with isoAccountId, not staticValues.${ISO_FIELD}`);
  }
  const staticValues: Record<string, StaticValue> = { ...input.staticValues };
  if (input.isoAccountId) staticValues[ISO_FIELD] = input.isoAccountId;
  const ownerFixedId = input.ownerMode === "fixed" ? input.ownerFixedId : null;
  try {
    validateFieldMapping(input.fieldMapping);
    validateStaticValues(staticValues);
    validateOwner(input.ownerMode, ownerFixedId);
  } catch (err) {
    if (err instanceof SfSettingsError) throw new SfSettingsValidationError(err.message);
    throw err;
  }
  return { ...input, staticValues, ownerFixedId };
}

/**
 * Saves the Salesforce settings of an event type.
 *
 * For a variant, overrideParent decides inheritance: true writes the variant's own row and
 * adds "sf_settings" to its overrides; false removes the override so the parent's row
 * applies again (the variant's own row, if any, is kept untouched for later reuse and the
 * other input fields are ignored). For a non-variant overrideParent is ignored.
 */
export async function saveSfSettings(actor: Actor, eventTypeId: string, raw: SfSettingsInput): Promise<SfSettingsView> {
  z.string().uuid().parse(eventTypeId);
  const input = normalizeInput(raw);
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    const before = await readView(tx, eventTypeId);
    const inherit = before.isVariant && input.overrideParent === false;

    if (before.isVariant) {
      await tx`
        update app.event_types set overrides = ${
          inherit
            ? tx`array_remove(overrides, ${SF_SETTINGS_OVERRIDE_KEY})`
            : tx`(select array_agg(distinct o) from unnest(array_append(overrides, ${SF_SETTINGS_OVERRIDE_KEY})) o)`
        }
        where id = ${eventTypeId}
      `;
    }

    if (!inherit) {
      await tx`
        insert into app.event_type_sf_settings
          (event_type_id, create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id,
           create_task, create_note, set_meeting_booked_fields, updated_by)
        values (${eventTypeId}, ${input.createSfLead}, ${tx.json(input.fieldMapping)}, ${tx.json(input.staticValues as never)},
                ${input.campaignId}, ${input.ownerMode}, ${input.ownerFixedId},
                ${input.createTask}, ${input.createNote}, ${input.setMeetingBookedFields}, ${actor.id})
        on conflict (event_type_id) do update set
          create_sf_lead = excluded.create_sf_lead,
          field_mapping = excluded.field_mapping,
          static_values = excluded.static_values,
          campaign_id = excluded.campaign_id,
          owner_mode = excluded.owner_mode,
          owner_fixed_id = excluded.owner_fixed_id,
          create_task = excluded.create_task,
          create_note = excluded.create_note,
          set_meeting_booked_fields = excluded.set_meeting_booked_fields,
          updated_by = excluded.updated_by
      `;
    }

    const after = await readView(tx, eventTypeId);
    const snapshot = (v: SfSettingsView) => ({
      own: v.own && { ...v.own, updatedAt: undefined },
      overridesParent: v.overridesParent,
      provenance: v.provenance,
      effectiveCreateSfLead: v.effective?.createSfLead ?? false,
    });
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "sf_settings.update",
      entityType: "event_type_sf_settings",
      entityId: eventTypeId,
      before: snapshot(before),
      after: snapshot(after),
    });
    const wasOn = before.effective?.createSfLead ?? false;
    const isOn = after.effective?.createSfLead ?? false;
    if (wasOn !== isOn) {
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "sf_settings.toggle",
        entityType: "event_type_sf_settings",
        entityId: eventTypeId,
        before: { createSfLead: wasOn },
        after: { createSfLead: isOn },
      });
    }
    return after;
  });
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export type SfLeadJobAttempt = {
  attemptNo: number;
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
  requestSummary: Record<string, unknown> | null;
  createdAt: string;
};

export type SfLeadJobView = {
  id: string;
  bookingId: string | null;
  eventTypeId: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  result: Record<string, unknown> | null;
  sfLeadId: string | null;
  sfLeadStatus: string | null;
  createdAt: string;
  updatedAt: string;
  attemptLog: SfLeadJobAttempt[];
};

export const sfLeadJobFiltersSchema = z
  .object({
    status: z.array(z.enum(["pending", "running", "succeeded", "failed", "dead"])).optional(),
    sfLeadStatus: z.array(z.enum(["pending", "created", "duplicate", "failed", "skipped"])).optional(),
    eventTypeId: z.string().uuid().optional(),
    bookingId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type SfLeadJobFilters = z.input<typeof sfLeadJobFiltersSchema>;

type JobViewRow = {
  id: string;
  booking_id: string | null;
  event_type_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
  result: Record<string, unknown> | null;
  sf_lead_id: string | null;
  sf_lead_status: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function listSfLeadJobs(actor: Actor, filters: SfLeadJobFilters = {}): Promise<SfLeadJobView[]> {
  const f = sfLeadJobFiltersSchema.parse(filters);
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    const rows = await tx<JobViewRow[]>`
      select id, booking_id, event_type_id, status, attempts, max_attempts, run_at, last_error, result,
             sf_lead_id, sf_lead_status, created_at, updated_at
      from app.sf_lead_jobs
      where true
        ${f.status ? tx`and status::text = any(${f.status})` : tx``}
        ${f.sfLeadStatus ? tx`and sf_lead_status = any(${f.sfLeadStatus})` : tx``}
        ${f.eventTypeId ? tx`and event_type_id = ${f.eventTypeId}` : tx``}
        ${f.bookingId ? tx`and booking_id = ${f.bookingId}` : tx``}
      order by created_at desc, id
      limit ${f.limit} offset ${f.offset}
    `;
    const ids = rows.map((r) => r.id);
    const attempts = ids.length
      ? await tx<{ job_id: string; attempt_no: number; response_code: number | null; error: string | null; duration_ms: number | null; request_summary: Record<string, unknown> | null; created_at: Date }[]>`
          select job_id, attempt_no, response_code, error, duration_ms, request_summary, created_at
          from app.job_attempts where job_id = any(${ids}::uuid[])
          order by attempt_no, created_at
        `
      : [];
    return rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      eventTypeId: r.event_type_id,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      runAt: r.run_at.toISOString(),
      lastError: r.last_error,
      result: r.result,
      sfLeadId: r.sf_lead_id,
      sfLeadStatus: r.sf_lead_status,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      attemptLog: attempts
        .filter((a) => a.job_id === r.id)
        .map((a) => ({
          attemptNo: a.attempt_no,
          responseCode: a.response_code,
          error: a.error,
          durationMs: a.duration_ms,
          requestSummary: a.request_summary,
          createdAt: a.created_at.toISOString(),
        })),
    }));
  });
}

/**
 * Re-queues a dead or failed lead job to run now. The attempt counter and history are kept;
 * the ceiling becomes attempts + SF_LEAD_MAX_ATTEMPTS so the job gets a full new budget.
 */
export async function retrySfLeadJob(
  actor: Actor,
  jobId: string,
): Promise<{ id: string; status: string; attempts: number; maxAttempts: number }> {
  z.string().uuid().parse(jobId);
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    let row;
    try {
      [row] = await tx<{
        id: string;
        booking_id: string | null;
        status: string;
        attempts: number;
        max_attempts: number;
        prev_status: string;
        prev_max_attempts: number;
        prev_last_error: string | null;
      }[]>`select * from app.retry_sf_lead_job(${jobId}, ${env().SF_LEAD_MAX_ATTEMPTS})`;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42501") throw new ForbiddenError();
      if (code === "P0002") throw new NotFoundError("Job not found");
      throw err;
    }
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "sf_lead_job.retry",
      entityType: "job",
      entityId: jobId,
      before: { status: row.prev_status, maxAttempts: row.prev_max_attempts, lastError: row.prev_last_error },
      after: { status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, bookingId: row.booking_id },
    });
    return { id: row.id, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts };
  });
}
