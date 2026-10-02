"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { getSfSettings, retrySfLeadJob, saveSfSettings } from "@/server/salesforce/admin";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, json, ok, pgCode, str } from "@/server/ui/form";
import { adminError, audited } from "@/server/ui/admin";
import { SF_ACCOUNT_ID_RE, SF_CAMPAIGN_ID_RE, SF_FIELD_RE, SF_OWNER_ID_RE } from "@/lib/ids";
import { ISO_FIELD, SF_BUILTIN_SOURCES } from "@/lib/salesforce";

/**
 * Admin actions for Salesforce lead settings and the lead outbox. Each action parses the form
 * and delegates to src/server/salesforce/admin.ts, which requires the admin role, validates
 * the settings again and writes the audit entries in the same transaction as the change.
 */

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
    createTask: z.boolean(),
    createNote: z.boolean(),
    setMeetingBookedFields: z.boolean(),
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

/** Question keys a mapping may refer to: the variant's own questions, or the parent's when inherited. */
async function questionSources(userId: string, eventTypeId: string, parentId: string | null): Promise<Set<string>> {
  return withUser(userId, async (tx) => {
    let owner = eventTypeId;
    if (parentId) {
      const [et] = await tx<{ overrides: string[] }[]>`select overrides from app.event_types where id = ${eventTypeId}`;
      if (et && !et.overrides.includes("questions")) owner = parentId;
    }
    const rows = await tx<{ key: string }[]>`select key from app.event_type_questions where event_type_id = ${owner}`;
    return new Set(rows.map((q) => `q:${q.key}`));
  });
}

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
    createTask: bool(fd, "createTask"),
    createNote: bool(fd, "createNote"),
    setMeetingBookedFields: bool(fd, "setMeetingBookedFields"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;

  try {
    const view = await getSfSettings(user, eventTypeId);
    if (view.isVariant && !view.overridesParent) {
      return fail("This variant inherits Salesforce settings from its parent. Turn off inheritance first.");
    }
    const qKeys = await questionSources(user.id, eventTypeId, view.parentEventTypeId);
    const badIndex = v.fieldMapping.findIndex((m) => !builtins.has(m.source) && !qKeys.has(m.source));
    if (badIndex >= 0) {
      const src = v.fieldMapping[badIndex].source;
      return fail(`Mapping ${badIndex + 1} uses "${src}", which is not a booking field or a question on this event type.`, {
        [`fieldMapping.${badIndex}.source`]: "Unknown source. Choose another or remove this mapping.",
      });
    }

    await audited(() =>
      saveSfSettings(user, eventTypeId, {
        createSfLead: v.createSfLead,
        isoAccountId: v.isoAccountId || null,
        fieldMapping: Object.fromEntries(v.fieldMapping.map((m) => [m.source, m.field])),
        staticValues: Object.fromEntries(v.staticValues.map((s) => [s.key, s.value])),
        campaignId: v.campaignId || null,
        ownerMode: v.ownerMode,
        ownerFixedId: v.ownerMode === "fixed" ? v.ownerFixedId : null,
        createTask: v.createTask,
        createNote: v.createNote,
        setMeetingBookedFields: v.setMeetingBookedFields,
        ...(view.isVariant ? { overrideParent: true } : {}),
      }),
    );
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(`/admin/event-types/${eventTypeId}/salesforce`);
  return ok(v.createSfLead ? "Saved. New bookings will create a Salesforce Lead." : "Saved. Lead creation is off.");
}

const RETRY_ERRORS: Record<string, string> = {
  "55000": "Only failed or dead jobs can be retried.",
  "22023": "Invalid retry request.",
};

export async function retrySfJobAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const jobId = str(fd, "jobId");
  if (!isUuid(jobId)) return fail("Invalid job.");
  let res;
  try {
    res = await audited(() => retrySfLeadJob(user, jobId));
  } catch (err) {
    const code = pgCode(err);
    if (code && RETRY_ERRORS[code]) return fail(RETRY_ERRORS[code]);
    return adminError(err);
  }
  revalidatePath("/admin/salesforce/jobs");
  revalidatePath("/admin");
  return ok(`Job queued for retry. It now has up to ${res.maxAttempts - res.attempts} more attempts.`);
}
