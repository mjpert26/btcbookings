"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, json, ok, pgCode, pgConstraint, str } from "@/server/ui/form";
import { HEX_COLOR_RE, hostSchema, questionsSchema, REMINDER_CHOICES, SLUG_RE, VARIANT_GROUPS, type VariantGroupKey } from "@/lib/event-types";
import { isReservedSlug } from "@/server/auth/slug";
import { canWrite, loadBundle } from "./_data";

const optionalInt = (min: number, max: number) =>
  z.union([z.literal(""), z.coerce.number().int("Use a whole number.").min(min, `Must be at least ${min}.`).max(max, `Must be at most ${max}.`)]).transform((v) => (v === "" ? null : v));

const requiredInt = (min: number, max: number) => z.coerce.number().int("Use a whole number.").min(min, `Must be at least ${min}.`).max(max, `Must be at most ${max}.`);

const formSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(120, "Keep the name under 120 characters."),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SLUG_RE, "Use lowercase letters, numbers and hyphens (not at the start or end).")
      .refine((s) => !isReservedSlug(s), "This slug is reserved."),
    descriptionEn: z.string().trim().max(2000, "Keep the description under 2000 characters."),
    descriptionEs: z.string().trim().max(2000, "Keep the description under 2000 characters."),
    durations: z.array(z.coerce.number().int().min(5).max(480)).min(1, "Choose at least one duration.").max(10),
    defaultDuration: z.coerce.number().int(),
    locationType: z.enum(["teams", "phone", "in_person", "custom"]),
    locationDetail: z.string().trim().max(500, "Keep this under 500 characters."),
    scheduleId: z.union([z.literal(""), z.string().uuid()]).transform((v) => (v === "" ? null : v)),
    bufferBefore: requiredInt(0, 240),
    bufferAfter: requiredInt(0, 240),
    minNotice: requiredInt(0, 525600),
    maxPerDay: optionalInt(1, 100),
    bookingWindowDays: requiredInt(1, 365),
    slotInterval: optionalInt(5, 240),
    reminders: z.array(z.coerce.number().refine((n) => REMINDER_CHOICES.some((r) => r.value === n), "Unknown reminder.")).max(8),
    isActive: z.boolean(),
    isListed: z.boolean(),
    brandAccent: z.union([z.literal(""), z.string().regex(HEX_COLOR_RE, "Use a hex color like #0D66A5.")]).transform((v) => (v === "" ? null : v)),
    questions: questionsSchema,
    schedulingMode: z.enum(["round_robin", "collective"]).optional(),
    rrStrategy: z.enum(["fairness", "weighted", "priority"]).optional(),
    rrSticky: z.boolean(),
    hosts: z.array(hostSchema).max(200),
  })
  .superRefine((v, ctx) => {
    if (!v.durations.includes(v.defaultDuration)) {
      ctx.addIssue({ code: "custom", path: ["defaultDuration"], message: "The default must be one of the selected durations." });
    }
    if ((v.locationType === "in_person" || v.locationType === "custom") && !v.locationDetail) {
      ctx.addIssue({ code: "custom", path: ["locationDetail"], message: v.locationType === "in_person" ? "Enter the address." : "Describe the location." });
    }
  });

type FormValues = z.output<typeof formSchema>;

function readForm(fd: FormData) {
  return formSchema.safeParse({
    name: str(fd, "name"),
    slug: str(fd, "slug"),
    descriptionEn: str(fd, "descriptionEn"),
    descriptionEs: str(fd, "descriptionEs"),
    durations: fd.getAll("durations").map(String),
    defaultDuration: str(fd, "defaultDuration"),
    locationType: str(fd, "locationType"),
    locationDetail: str(fd, "locationDetail"),
    scheduleId: str(fd, "scheduleId"),
    bufferBefore: str(fd, "bufferBefore") || "0",
    bufferAfter: str(fd, "bufferAfter") || "0",
    minNotice: str(fd, "minNotice") || "0",
    maxPerDay: str(fd, "maxPerDay"),
    bookingWindowDays: str(fd, "bookingWindowDays"),
    slotInterval: str(fd, "slotInterval"),
    reminders: fd.getAll("reminders").map(String),
    isActive: bool(fd, "isActive"),
    isListed: bool(fd, "isListed"),
    brandAccent: str(fd, "brandAccent"),
    questions: json(fd, "questions") ?? [],
    schedulingMode: str(fd, "schedulingMode") || undefined,
    rrStrategy: str(fd, "rrStrategy") || undefined,
    rrSticky: bool(fd, "rrSticky"),
    hosts: json(fd, "hosts") ?? [],
  });
}

function slugConflict(err: unknown): boolean {
  const c = pgConstraint(err);
  return pgCode(err) === "23505" && (c === "event_types_user_slug_lang" || c === "event_types_team_slug_lang");
}

async function saveQuestions(tx: Tx, eventTypeId: string, questions: FormValues["questions"]): Promise<void> {
  const keys = questions.map((q) => q.key);
  await tx`delete from app.event_type_questions where event_type_id = ${eventTypeId} and not (key = any(${keys}))`;
  for (const [i, q] of questions.entries()) {
    const label = { ...(q.label.en ? { en: q.label.en } : {}), ...(q.label.es ? { es: q.label.es } : {}) };
    const options = q.type === "dropdown" ? q.options.map((o) => ({ value: o.value, label: { ...(o.label.en ? { en: o.label.en } : {}), ...(o.label.es ? { es: o.label.es } : {}) } })) : [];
    await tx`
      insert into app.event_type_questions (event_type_id, key, type, label, options, required, position)
      values (${eventTypeId}, ${q.key}, ${q.type}, ${tx.json(label)}, ${tx.json(options)}, ${q.required}, ${i})
      on conflict (event_type_id, key) do update
        set type = excluded.type, label = excluded.label, options = excluded.options,
            required = excluded.required, position = excluded.position
    `;
  }
}

async function saveHosts(tx: Tx, eventTypeId: string, teamId: string, hosts: FormValues["hosts"]): Promise<string | null> {
  const ids = [...new Set(hosts.map((h) => h.teamMemberId))];
  if (ids.length) {
    const valid = await tx<{ id: string }[]>`select id from app.team_members where team_id = ${teamId} and id = any(${ids})`;
    if (valid.length !== ids.length) return "One of the selected hosts is not a member of this team.";
  }
  await tx`delete from app.event_type_hosts where event_type_id = ${eventTypeId}`;
  for (const h of hosts) {
    await tx`
      insert into app.event_type_hosts (event_type_id, team_member_id, is_required, weight_override, priority_tier_override)
      values (${eventTypeId}, ${h.teamMemberId}, ${h.isRequired}, ${h.weightOverride}, ${h.priorityTierOverride})
      on conflict do nothing
    `;
  }
  return null;
}

function description(v: FormValues): Record<string, string> {
  return { ...(v.descriptionEn ? { en: v.descriptionEn } : {}), ...(v.descriptionEs ? { es: v.descriptionEs } : {}) };
}

export async function createEventTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const owner = str(fd, "owner");
  const language = str(fd, "language") === "es" ? "es" : "en";
  const parsed = readForm(fd);
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const teamId = owner && owner !== "me" ? owner : null;
  if (teamId && !isUuid(teamId)) return fail("Choose a valid owner.", { owner: "Choose a valid owner." });

  let id: string;
  try {
    const result = await withUser(user.id, async (tx) => {
      if (teamId) {
        const [ok] = await tx<{ ok: boolean }[]>`select app.is_team_admin(${teamId}) as ok`;
        if (!ok?.ok) return { error: "You can only create event types for teams you manage." };
      }
      // No RETURNING: the SELECT policy's security-definer check cannot see a row inserted
      // by the same statement, so the id is generated here instead.
      const row = { id: randomUUID() };
      await tx`
        insert into app.event_types (
          id, owner_user_id, team_id, slug, language, name, description, durations, default_duration,
          location_type, location_detail, schedule_id, buffer_before_min, buffer_after_min, min_notice_min,
          max_per_day, booking_window_days, slot_interval_min, scheduling_mode, rr_strategy,
          rr_sticky_returning_invitee, reminder_offsets_min, is_active, is_listed, brand_accent
        ) values (
          ${row.id}, ${teamId ? null : user.id}, ${teamId}, ${v.slug}, ${language}, ${v.name}, ${tx.json(description(v))},
          ${v.durations}, ${v.defaultDuration}, ${v.locationType}, ${v.locationDetail || null}, ${v.scheduleId},
          ${v.bufferBefore}, ${v.bufferAfter}, ${v.minNotice}, ${v.maxPerDay}, ${v.bookingWindowDays}, ${v.slotInterval},
          ${teamId ? (v.schedulingMode ?? "round_robin") : "individual"}, ${v.rrStrategy ?? "fairness"},
          ${teamId ? v.rrSticky : false}, ${v.reminders}, ${v.isActive}, ${v.isListed}, ${v.brandAccent}
        )
      `;
      await saveQuestions(tx, row.id, v.questions);
      if (teamId) {
        const err = await saveHosts(tx, row.id, teamId, v.hosts);
        if (err) throw new HostError(err);
      }
      await writeAudit(tx, { actorUserId: user.id, action: "event_type.create", entityType: "event_type", entityId: row.id, after: { name: v.name, slug: v.slug, teamId } });
      return { id: row.id };
    });
    if ("error" in result) return fail(result.error as string);
    id = result.id;
  } catch (err) {
    if (err instanceof HostError) return fail(err.message, { hosts: err.message });
    if (slugConflict(err)) return fail("That slug is already used.", { slug: `You already have a ${language === "es" ? "Spanish" : "English"} event type with this slug.` });
    throw err;
  }
  revalidatePath("/event-types");
  redirect(`/event-types/${id}?created=1`);
}

class HostError extends Error {}

export async function updateEventTypeAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(id)) return fail("Event type not found.");
  const parsed = readForm(fd);
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;

  try {
    const res = await withUser(user.id, async (tx) => {
      if (!(await canWrite(tx, id))) return "not_found" as const;
      const bundle = await loadBundle(tx, id);
      if (!bundle) return "not_found" as const;
      const et = bundle.eventType;
      const isChild = Boolean(et.parent_event_type_id);
      const own = (g: VariantGroupKey) => !isChild || et.overrides.includes(g);

      // Inherited groups on a variant are read-only here; they are edited on the parent.
      await tx`
        update app.event_types set
          name = ${v.name},
          slug = ${isChild ? et.slug : v.slug},
          description = ${own("branding") ? tx.json(description(v)) : tx.json(et.description)},
          brand_accent = ${own("branding") ? v.brandAccent : et.brand_accent},
          durations = ${own("durations") ? v.durations : et.durations},
          default_duration = ${own("durations") ? v.defaultDuration : et.default_duration},
          location_type = ${own("location") ? v.locationType : et.location_type},
          location_detail = ${own("location") ? v.locationDetail || null : et.location_detail},
          buffer_before_min = ${own("buffers") ? v.bufferBefore : et.buffer_before_min},
          buffer_after_min = ${own("buffers") ? v.bufferAfter : et.buffer_after_min},
          min_notice_min = ${own("buffers") ? v.minNotice : et.min_notice_min},
          schedule_id = ${v.scheduleId},
          max_per_day = ${v.maxPerDay},
          booking_window_days = ${v.bookingWindowDays},
          slot_interval_min = ${v.slotInterval},
          scheduling_mode = ${et.team_id ? (v.schedulingMode ?? et.scheduling_mode) : "individual"},
          rr_strategy = ${v.rrStrategy ?? et.rr_strategy},
          rr_sticky_returning_invitee = ${et.team_id ? v.rrSticky : false},
          reminder_offsets_min = ${v.reminders},
          is_active = ${v.isActive},
          is_listed = ${v.isListed}
        where id = ${id}
      `;
      if (!isChild && v.slug !== et.slug) {
        await tx`update app.event_types set slug = ${v.slug} where parent_event_type_id = ${id}`;
      }
      if (own("questions")) await saveQuestions(tx, id, v.questions);
      if (et.team_id) {
        const err = await saveHosts(tx, id, et.team_id, v.hosts);
        if (err) throw new HostError(err);
      }
      await writeAudit(tx, {
        actorUserId: user.id,
        action: "event_type.update",
        entityType: "event_type",
        entityId: id,
        before: { name: et.name, slug: et.slug, is_active: et.is_active },
        after: { name: v.name, slug: isChild ? et.slug : v.slug, is_active: v.isActive },
      });
      return "ok" as const;
    });
    if (res === "not_found") return fail("Event type not found or you cannot edit it.");
  } catch (err) {
    if (err instanceof HostError) return fail(err.message, { hosts: err.message });
    if (slugConflict(err)) return fail("That slug is already used.", { slug: "Another event type of yours uses this slug in the same language." });
    throw err;
  }
  revalidatePath(`/event-types/${id}`);
  revalidatePath("/event-types");
  return ok("Event type saved.");
}

export async function deleteEventTypeAction(id: string): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(id)) return fail("Event type not found.");
  try {
    const res = await withUser(user.id, async (tx) => {
      if (!(await canWrite(tx, id))) return false;
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.bookings
        where event_type_id = ${id} or event_type_id in (select id from app.event_types where parent_event_type_id = ${id})
      `;
      if (n > 0) throw new HostError("This event type has bookings, so it cannot be deleted. Turn it off instead.");
      const [row] = await tx<{ name: string }[]>`delete from app.event_types where id = ${id} returning name`;
      if (!row) return false;
      await writeAudit(tx, { actorUserId: user.id, action: "event_type.delete", entityType: "event_type", entityId: id, before: { name: row.name } });
      return true;
    });
    if (!res) return fail("Event type not found or you cannot delete it.");
  } catch (err) {
    if (err instanceof HostError) return fail(err.message);
    throw err;
  }
  revalidatePath("/event-types");
  redirect("/event-types?deleted=1");
}

/** Creates the Spanish variant of an English event type: same slug, language "es", nothing overridden. */
export async function createSpanishVariantAction(parentId: string): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(parentId)) return fail("Event type not found.");
  let childId: string | null = null;
  try {
    childId = await withUser(user.id, async (tx) => {
      if (!(await canWrite(tx, parentId))) return null;
      const [p] = await tx<{ id: string; language: string; parent_event_type_id: string | null }[]>`
        select id, language, parent_event_type_id from app.event_types where id = ${parentId}
      `;
      if (!p || p.parent_event_type_id || p.language !== "en") return null;
      const row = { id: randomUUID() };
      await tx`
        insert into app.event_types (
          id, owner_user_id, team_id, slug, language, parent_event_type_id, overrides, name, description, durations,
          default_duration, location_type, location_detail, schedule_id, buffer_before_min, buffer_after_min,
          min_notice_min, max_per_day, booking_window_days, slot_interval_min, scheduling_mode, rr_strategy,
          rr_sticky_returning_invitee, reminder_offsets_min, is_active, is_listed, brand_accent
        )
        select ${row.id}, owner_user_id, team_id, slug, 'es', id, '{}', name, description, durations,
               default_duration, location_type, location_detail, schedule_id, buffer_before_min, buffer_after_min,
               min_notice_min, max_per_day, booking_window_days, slot_interval_min, scheduling_mode, rr_strategy,
               rr_sticky_returning_invitee, reminder_offsets_min, false, is_listed, brand_accent
        from app.event_types where id = ${parentId}
      `;
      await writeAudit(tx, { actorUserId: user.id, action: "event_type.create_variant", entityType: "event_type", entityId: row.id, after: { parentId, language: "es" } });
      return row.id;
    });
  } catch (err) {
    if (pgCode(err) === "23505") return fail("A Spanish variant already exists.");
    throw err;
  }
  if (!childId) return fail("Only English event types you manage can get a Spanish variant.");
  revalidatePath(`/event-types/${parentId}`);
  revalidatePath("/event-types");
  redirect(`/event-types/${parentId}/variants?created=1`);
}

const toggleSchema = z.object({
  group: z.enum(VARIANT_GROUPS.map((g) => g.key) as [VariantGroupKey, ...VariantGroupKey[]]),
  override: z.boolean(),
});

/**
 * Turns inheritance off (override) or back on for one group of a variant. When a group
 * becomes overridden, the parent's current values are copied so the variant starts identical.
 */
export async function toggleOverrideAction(childId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = toggleSchema.safeParse({ group: str(fd, "group"), override: str(fd, "override") === "1" });
  if (!parsed.success || !isUuid(childId)) return fail("Invalid request.");
  const { group, override } = parsed.data;
  if (group === "sf_settings" && user.role !== "admin") return fail("Only admins can change Salesforce inheritance.");

  const res = await withUser(user.id, async (tx) => {
    if (!(await canWrite(tx, childId))) return "not_found" as const;
    const [c] = await tx<{ parent_event_type_id: string | null; overrides: string[] }[]>`
      select parent_event_type_id, overrides from app.event_types where id = ${childId}
    `;
    if (!c?.parent_event_type_id) return "not_variant" as const;
    const parentId = c.parent_event_type_id;
    const next = override ? [...new Set([...c.overrides, group])] : c.overrides.filter((g) => g !== group);
    await tx`update app.event_types set overrides = ${next} where id = ${childId}`;

    if (override) {
      if (group === "durations") {
        await tx`update app.event_types c set durations = p.durations, default_duration = p.default_duration from app.event_types p where p.id = ${parentId} and c.id = ${childId}`;
      } else if (group === "location") {
        await tx`update app.event_types c set location_type = p.location_type, location_detail = p.location_detail from app.event_types p where p.id = ${parentId} and c.id = ${childId}`;
      } else if (group === "buffers") {
        await tx`update app.event_types c set buffer_before_min = p.buffer_before_min, buffer_after_min = p.buffer_after_min, min_notice_min = p.min_notice_min from app.event_types p where p.id = ${parentId} and c.id = ${childId}`;
      } else if (group === "branding") {
        await tx`update app.event_types c set brand_accent = p.brand_accent, description = p.description from app.event_types p where p.id = ${parentId} and c.id = ${childId}`;
      } else if (group === "questions") {
        await tx`delete from app.event_type_questions where event_type_id = ${childId}`;
        await tx`
          insert into app.event_type_questions (event_type_id, key, type, label, options, required, position)
          select ${childId}, key, type, label, options, required, position from app.event_type_questions where event_type_id = ${parentId}
        `;
      } else if (group === "sf_settings") {
        await tx`
          insert into app.event_type_sf_settings (event_type_id, create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id,
                                                  create_task, create_note, set_meeting_booked_fields, updated_by)
          select ${childId}, create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id,
                 create_task, create_note, set_meeting_booked_fields, ${user.id}
          from app.event_type_sf_settings where event_type_id = ${parentId}
          on conflict (event_type_id) do nothing
        `;
        await tx`
          insert into app.event_type_sf_settings (event_type_id, updated_by) values (${childId}, ${user.id})
          on conflict (event_type_id) do nothing
        `;
      }
    } else if (group === "sf_settings") {
      // The resolver treats a variant's own Salesforce row as an override, so remove it.
      await tx`delete from app.event_type_sf_settings where event_type_id = ${childId}`;
    }
    await writeAudit(tx, {
      actorUserId: user.id,
      action: override ? "event_type.override_group" : "event_type.inherit_group",
      entityType: "event_type",
      entityId: childId,
      before: { overrides: c.overrides },
      after: { overrides: next },
    });
    return parentId;
  });
  if (res === "not_found") return fail("Event type not found or you cannot edit it.");
  if (res === "not_variant") return fail("This event type is not a language variant.");
  revalidatePath(`/event-types/${res}/variants`);
  revalidatePath(`/event-types/${childId}`);
  if (group === "sf_settings") revalidatePath(`/admin/event-types/${childId}/salesforce`);
  const label = VARIANT_GROUPS.find((g) => g.key === group)?.label ?? group;
  return ok(override ? `${label} is now overridden on the variant.` : `${label} is inherited from the parent again.`);
}
