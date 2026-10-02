"use server";

// TODO(integration): delegate to src/server/salesforce/admin.ts after merge:
//   saveSfSettingsAction -> saveSfSettings(actor, eventTypeId, input)   (getSfSettings for the page)
//   retrySfJobAction     -> retrySfLeadJob(actor, jobId)
// The jobs page query should then use listSfLeadJobs(actor, filters).
// These thin versions do the database work directly with withUser + writeAudit.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, json, ok, requestIpHash, str } from "@/server/ui/form";
import { SF_ACCOUNT_ID_RE, SF_CAMPAIGN_ID_RE, SF_FIELD_RE, SF_OWNER_ID_RE } from "@/lib/ids";
import { ISO_FIELD, SF_BUILTIN_SOURCES } from "@/lib/salesforce";

const builtins = new Set<string>(SF_BUILTIN_SOURCES.map((s) => s.value));

const settingsSchema = z
  .object({
    createSfLead: z.boolean(),
    isoAccountId: z.union([z.literal(""), z.string().regex(SF_ACCOUNT_ID_RE, "Account IDs start with 001 and are 15 or 18 characters.")]),
    campaignId: z.union([z.literal(""), z.string().regex(SF_CAMPAIGN_ID_RE, "Campaign IDs start with 701 and are 15 or 18 characters.")]),
    ownerMode: z.enum(["assigned_host", "fixed", "assignment_rules"]),
    ownerFixedId: z.union([z.literal(""), z.string().regex(SF_OWNER_ID_RE, "Use a User ID (005...) or Queue ID (00G...).")]),
    fieldMapping: z
      .array(z.object({ source: z.string().min(1, "Choose a source."), field: z.string().trim().regex(SF_FIELD_RE, "Use a Lead field API name, e.g. Company.") }))
      .max(60),
    staticValues: z
      .array(z.object({ key: z.string().trim().regex(SF_FIELD_RE, "Use a Lead field API name."), value: z.string().trim().max(255, "Keep values under 255 characters.") }))
      .max(40),
  })
  .superRefine((v, ctx) => {
    if (v.ownerMode === "fixed" && !v.ownerFixedId) ctx.addIssue({ code: "custom", path: ["ownerFixedId"], message: "Enter the owner's User or Queue ID." });
    const sources = new Set<string>();
    const fields = new Set<string>();
    v.fieldMapping.forEach((m, i) => {
      if (sources.has(m.source)) ctx.addIssue({ code: "custom", path: ["fieldMapping", i, "source"], message: "This source is mapped twice." });
      if (fields.has(m.field.toLowerCase())) ctx.addIssue({ code: "custom", path: ["fieldMapping", i, "field"], message: "This Lead field is mapped twice." });
      sources.add(m.source);
      fields.add(m.field.toLowerCase());
    });
    const keys = new Set<string>();
    v.staticValues.forEach((s, i) => {
      if (s.key === ISO_FIELD) ctx.addIssue({ code: "custom", path: ["staticValues", i, "key"], message: "Set the ISO with the Lead source field above." });
      if (keys.has(s.key.toLowerCase())) ctx.addIssue({ code: "custom", path: ["staticValues", i, "key"], message: "Duplicate field." });
      if (fields.has(s.key.toLowerCase())) ctx.addIssue({ code: "custom", path: ["staticValues", i, "key"], message: "This field is already mapped from booking data." });
      keys.add(s.key.toLowerCase());
    });
  });

export async function saveSfSettingsAction(eventTypeId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(eventTypeId)) return fail("Event type not found.");
  const parsed = settingsSchema.safeParse({
    createSfLead: bool(fd, "createSfLead"),
    isoAccountId: str(fd, "isoAccountId"),
    campaignId: str(fd, "campaignId"),
    ownerMode: str(fd, "ownerMode"),
    ownerFixedId: str(fd, "ownerFixedId"),
    fieldMapping: json(fd, "fieldMapping") ?? [],
    staticValues: json(fd, "staticValues") ?? [],
  });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const ipHash = await requestIpHash();

  const res = await withUser(user.id, async (tx) => {
    const [et] = await tx<{ id: string; parent_event_type_id: string | null; overrides: string[] }[]>`
      select id, parent_event_type_id, overrides from app.event_types where id = ${eventTypeId}
    `;
    if (!et) return { error: "Event type not found." };
    if (et.parent_event_type_id && !et.overrides.includes("sf_settings")) {
      return { error: "This variant inherits Salesforce settings from its parent. Turn off inheritance first." };
    }
    // Question sources must refer to questions on the event type (or its parent when inherited).
    const questionOwner = et.parent_event_type_id && !et.overrides.includes("questions") ? et.parent_event_type_id : et.id;
    const qs = await tx<{ key: string }[]>`select key from app.event_type_questions where event_type_id = ${questionOwner}`;
    const qKeys = new Set(qs.map((q) => `q:${q.key}`));
    const badIndex = v.fieldMapping.findIndex((m) => !builtins.has(m.source) && !qKeys.has(m.source));
    if (badIndex >= 0) {
      const src = v.fieldMapping[badIndex].source;
      return { error: `Mapping ${badIndex + 1} uses "${src}", which is not a booking field or a question on this event type.`, field: `fieldMapping.${badIndex}.source` };
    }

    const mapping = Object.fromEntries(v.fieldMapping.map((m) => [m.source, m.field]));
    const statics: Record<string, string> = Object.fromEntries(v.staticValues.map((s) => [s.key, s.value]));
    if (v.isoAccountId) statics[ISO_FIELD] = v.isoAccountId;

    const [before] = await tx`
      select create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id
      from app.event_type_sf_settings where event_type_id = ${eventTypeId}
    `;
    await tx`
      insert into app.event_type_sf_settings (event_type_id, create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id, updated_by)
      values (${eventTypeId}, ${v.createSfLead}, ${tx.json(mapping)}, ${tx.json(statics)}, ${v.campaignId || null}, ${v.ownerMode},
              ${v.ownerMode === "fixed" ? v.ownerFixedId : null}, ${user.id})
      on conflict (event_type_id) do update set
        create_sf_lead = excluded.create_sf_lead, field_mapping = excluded.field_mapping, static_values = excluded.static_values,
        campaign_id = excluded.campaign_id, owner_mode = excluded.owner_mode, owner_fixed_id = excluded.owner_fixed_id,
        updated_by = excluded.updated_by
    `;
    await writeAudit(tx, {
      actorUserId: user.id,
      action: "event_type.sf_settings_update",
      entityType: "event_type",
      entityId: eventTypeId,
      before: before ?? null,
      after: { create_sf_lead: v.createSfLead, field_mapping: mapping, static_values: statics, campaign_id: v.campaignId || null, owner_mode: v.ownerMode },
      ipHash,
    });
    return { ok: true };
  });
  if ("error" in res) return fail(res.error ?? "Could not save.", res.field ? { [res.field]: "Unknown source. Choose another or remove this mapping." } : undefined);
  revalidatePath(`/admin/event-types/${eventTypeId}/salesforce`);
  return ok(v.createSfLead ? "Saved. New bookings will create a Salesforce Lead." : "Saved. Lead creation is off.");
}

export async function retrySfJobAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const jobId = str(fd, "jobId");
  if (!isUuid(jobId)) return fail("Invalid job.");
  const ipHash = await requestIpHash();
  const done = await withUser(user.id, async (tx) => {
    const [j] = await tx<{ status: string; attempts: number }[]>`
      select status, attempts from app.jobs where id = ${jobId} and kind = 'sf_lead_create' for update
    `;
    if (!j || !["failed", "dead"].includes(j.status)) return false;
    await tx`update app.jobs set status = 'pending', run_at = now(), attempts = 0 where id = ${jobId}`;
    await writeAudit(tx, { actorUserId: user.id, action: "sf_lead_job.retry", entityType: "job", entityId: jobId, before: j, after: { status: "pending", attempts: 0 }, ipHash });
    return true;
  });
  if (!done) return fail("Only failed or dead jobs can be retried.");
  revalidatePath("/admin/salesforce/jobs");
  revalidatePath("/admin");
  return ok("Job queued for retry.");
}
