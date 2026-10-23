import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { service, type Tx } from "@/server/db/client";
import { env } from "@/server/env";
import { changedFields, writeAudit } from "@/server/audit";
import { isReservedSlug } from "@/server/auth/slug";
import { eventPath, loadEventTypeById } from "@/server/booking/load";
import { pickDuration, slotsFor } from "@/server/booking/slots";
import { BookingValidationError } from "@/server/booking/types";
import { HEX_COLOR_RE, hostSchema, questionsSchema, REMINDER_CHOICES, SLUG_RE, type Question, type VariantGroupKey } from "@/lib/event-types";
import { can } from "@/lib/permissions";
import { ApiError, asCaller, forbidden, invalid, mapDbError, notFound, type Caller } from "@/server/api/context";

const uuid = z.string().uuid();
const iso = z.iso.datetime({ offset: true });

export type EventTypeSummary = {
  id: string;
  name: string;
  slug: string;
  language: string;
  owner: { kind: "user" | "team"; id: string; name: string; slug: string };
  parentId: string | null;
  isActive: boolean;
  isListed: boolean;
  schedulingMode: string;
  durations: number[];
  defaultDuration: number;
  location: { type: string; detail: string | null };
  url: string;
  importedFrom: string | null;
};

type SummaryRow = {
  id: string;
  name: string;
  slug: string;
  language: string;
  owner_user_id: string | null;
  team_id: string | null;
  owner_name: string;
  owner_slug: string;
  parent_event_type_id: string | null;
  is_active: boolean;
  is_listed: boolean;
  scheduling_mode: string;
  durations: number[];
  default_duration: number;
  location_type: string;
  location_detail: string | null;
  import_source: string | null;
};

function publicUrl(r: Pick<SummaryRow, "team_id" | "owner_slug" | "slug" | "language">): string {
  return `${env().APP_BASE_URL}${eventPath(r.team_id ? "team" : "user", r.owner_slug, r.slug, r.language)}`;
}

function toSummary(r: SummaryRow): EventTypeSummary {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    language: r.language,
    owner: { kind: r.team_id ? "team" : "user", id: (r.team_id ?? r.owner_user_id)!, name: r.owner_name, slug: r.owner_slug },
    parentId: r.parent_event_type_id,
    isActive: r.is_active,
    isListed: r.is_listed,
    schedulingMode: r.scheduling_mode,
    durations: r.durations,
    defaultDuration: r.default_duration,
    location: { type: r.location_type, detail: r.location_detail },
    url: publicUrl(r),
    importedFrom: r.import_source,
  };
}

const SUMMARY_COLUMNS = (tx: Tx) => tx`
  et.id, et.name, et.slug, et.language, et.owner_user_id, et.team_id,
  coalesce(t.name, u.name) as owner_name, coalesce(t.slug, u.slug) as owner_slug, et.parent_event_type_id,
  et.is_active, et.is_listed, et.scheduling_mode::text as scheduling_mode, et.durations, et.default_duration,
  et.location_type::text as location_type, et.location_detail, et.import_source
`;

export const listEventTypesSchema = z.object({
  ownerUserId: uuid.optional(),
  teamId: uuid.optional(),
  active: z.boolean().optional(),
  /** Only the caller's own pages and pages of teams they belong to. */
  mine: z.boolean().optional(),
  search: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

/** Booking pages the caller can see under RLS (agents: their own and their teams'; managers and admins: all). */
export async function listEventTypes(caller: Caller, raw: z.input<typeof listEventTypesSchema>): Promise<EventTypeSummary[]> {
  const parsed = listEventTypesSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const q = parsed.data;
  return asCaller(caller, async (tx) => {
    const rows = await tx<SummaryRow[]>`
      select ${SUMMARY_COLUMNS(tx)}
      from app.event_types et
      left join app.users u on u.id = et.owner_user_id
      left join app.teams t on t.id = et.team_id
      where true
        ${q.ownerUserId ? tx`and et.owner_user_id = ${q.ownerUserId}` : tx``}
        ${q.teamId ? tx`and et.team_id = ${q.teamId}` : tx``}
        ${q.active === undefined ? tx`` : tx`and et.is_active = ${q.active}`}
        ${q.search ? tx`and et.name ilike ${"%" + q.search.replace(/[%_\\]/g, (m) => "\\" + m) + "%"}` : tx``}
        ${q.mine ? tx`and (et.owner_user_id = ${caller.user.id} or (et.team_id is not null and app.is_team_member(et.team_id)))` : tx``}
      order by coalesce(t.name, u.name), et.name, et.language
      limit ${q.limit} offset ${q.offset}
    `;
    return rows.map(toSummary);
  });
}

export type EventTypeDetail = EventTypeSummary & {
  description: Record<string, string>;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxPerDay: number | null;
  bookingWindowDays: number;
  slotIntervalMin: number | null;
  scheduleId: string | null;
  rrStrategy: string;
  rrSticky: boolean;
  reminderOffsetsMin: number[];
  brandAccent: string | null;
  overrides: string[];
  questions: Question[];
  hosts: { teamMemberId: string; userId: string | null; name: string | null; email: string; isRequired: boolean; weightOverride: number | null; priorityTierOverride: number | null }[];
};

export async function getEventType(caller: Caller, id: string): Promise<EventTypeDetail> {
  if (!uuid.safeParse(id).success) throw notFound("Booking page");
  return asCaller(caller, (tx) => loadDetail(tx, id));
}

async function loadDetail(tx: Tx, id: string): Promise<EventTypeDetail> {
  const [r] = await tx<(SummaryRow & {
    description: Record<string, string>;
    buffer_before_min: number;
    buffer_after_min: number;
    min_notice_min: number;
    max_per_day: number | null;
    booking_window_days: number;
    slot_interval_min: number | null;
    schedule_id: string | null;
    rr_strategy: string;
    rr_sticky_returning_invitee: boolean;
    reminder_offsets_min: number[];
    brand_accent: string | null;
    overrides: string[];
  })[]>`
    select ${SUMMARY_COLUMNS(tx)}, et.description, et.buffer_before_min, et.buffer_after_min, et.min_notice_min, et.max_per_day,
           et.booking_window_days, et.slot_interval_min, et.schedule_id, et.rr_strategy::text as rr_strategy, et.rr_sticky_returning_invitee,
           et.reminder_offsets_min, et.brand_accent, et.overrides
    from app.event_types et
    left join app.users u on u.id = et.owner_user_id
    left join app.teams t on t.id = et.team_id
    where et.id = ${id}
  `;
  if (!r) throw notFound("Booking page");
  const questions = await tx<{ key: string; type: Question["type"]; label: Record<string, string>; options: { value: string; label: Record<string, string> }[]; required: boolean }[]>`
    select key, type::text as type, label, options, required from app.event_type_questions where event_type_id = ${id} order by position
  `;
  const hosts = await tx<EventTypeDetail["hosts"]>`
    select h.team_member_id as "teamMemberId", tm.user_id as "userId", u.name, tm.email::text as email, h.is_required as "isRequired",
           h.weight_override as "weightOverride", h.priority_tier_override as "priorityTierOverride"
    from app.event_type_hosts h join app.team_members tm on tm.id = h.team_member_id left join app.users u on u.id = tm.user_id
    where h.event_type_id = ${id}
    order by u.name nulls last, tm.email
  `;
  return {
    ...toSummary(r),
    description: r.description,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    minNoticeMin: r.min_notice_min,
    maxPerDay: r.max_per_day,
    bookingWindowDays: r.booking_window_days,
    slotIntervalMin: r.slot_interval_min,
    scheduleId: r.schedule_id,
    rrStrategy: r.rr_strategy,
    rrSticky: r.rr_sticky_returning_invitee,
    reminderOffsetsMin: r.reminder_offsets_min,
    brandAccent: r.brand_accent,
    overrides: r.overrides,
    questions: questions.map((q) => ({
      key: q.key,
      type: q.type,
      label: { en: q.label.en ?? "", es: q.label.es ?? "" },
      required: q.required,
      options: (q.options ?? []).map((o) => ({ value: o.value, label: { en: o.label?.en ?? "", es: o.label?.es ?? "" } })),
    })),
    hosts,
  };
}

// ---------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------

const reminderSchema = z.number().refine((n) => REMINDER_CHOICES.some((r) => r.value === n), "Unknown reminder offset.");

const fields = {
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_RE, "Use lowercase letters, numbers and hyphens.")
    .refine((s) => !isReservedSlug(s), "This slug is reserved."),
  description: z.object({ en: z.string().trim().max(2000).optional(), es: z.string().trim().max(2000).optional() }),
  durations: z.array(z.number().int().min(5).max(480)).min(1).max(10),
  defaultDuration: z.number().int(),
  locationType: z.enum(["teams", "phone", "in_person", "custom"]),
  locationDetail: z.string().trim().max(500).nullable(),
  scheduleId: uuid.nullable(),
  bufferBeforeMin: z.number().int().min(0).max(240),
  bufferAfterMin: z.number().int().min(0).max(240),
  minNoticeMin: z.number().int().min(0).max(525600),
  maxPerDay: z.number().int().min(1).max(100).nullable(),
  bookingWindowDays: z.number().int().min(1).max(365),
  slotIntervalMin: z.number().int().min(5).max(240).nullable(),
  reminderOffsetsMin: z.array(reminderSchema).max(8),
  isActive: z.boolean(),
  isListed: z.boolean(),
  brandAccent: z.string().regex(HEX_COLOR_RE).nullable(),
  schedulingMode: z.enum(["round_robin", "collective"]),
  rrStrategy: z.enum(["fairness", "weighted", "priority"]),
  rrSticky: z.boolean(),
  hosts: z.array(hostSchema).max(200),
};

export const createEventTypeSchema = z
  .object({
    name: fields.name,
    slug: fields.slug,
    language: z.enum(["en", "es"]).default("en"),
    /** Create for a team (team admins and admins). */
    teamId: uuid.optional(),
    /** Create for another user (admins only). Defaults to the caller. */
    ownerUserId: uuid.optional(),
    description: fields.description.default({}),
    durations: fields.durations.default([30]),
    defaultDuration: fields.defaultDuration.optional(),
    locationType: fields.locationType.default("teams"),
    locationDetail: fields.locationDetail.default(null),
    scheduleId: fields.scheduleId.default(null),
    bufferBeforeMin: fields.bufferBeforeMin.default(0),
    bufferAfterMin: fields.bufferAfterMin.default(0),
    minNoticeMin: fields.minNoticeMin.default(240),
    maxPerDay: fields.maxPerDay.default(null),
    bookingWindowDays: fields.bookingWindowDays.default(30),
    slotIntervalMin: fields.slotIntervalMin.default(null),
    reminderOffsetsMin: fields.reminderOffsetsMin.default([1440, 60]),
    isActive: fields.isActive.default(false),
    isListed: fields.isListed.default(true),
    brandAccent: fields.brandAccent.default(null),
    schedulingMode: fields.schedulingMode.optional(),
    rrStrategy: fields.rrStrategy.default("fairness"),
    rrSticky: fields.rrSticky.default(false),
    questions: questionsSchema.default([]),
    hosts: fields.hosts.default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.teamId && v.ownerUserId) ctx.addIssue({ code: "custom", path: ["ownerUserId"], message: "Use teamId or ownerUserId, not both." });
    const def = v.defaultDuration ?? v.durations[0];
    if (!v.durations.includes(def)) ctx.addIssue({ code: "custom", path: ["defaultDuration"], message: "The default must be one of the durations." });
    if ((v.locationType === "in_person" || v.locationType === "custom") && !v.locationDetail) {
      ctx.addIssue({ code: "custom", path: ["locationDetail"], message: "Describe the location." });
    }
    if (!v.teamId && v.hosts.length) ctx.addIssue({ code: "custom", path: ["hosts"], message: "Hosts apply to team pages only." });
  });

export const updateEventTypeSchema = z
  .object({
    name: fields.name,
    slug: fields.slug,
    description: fields.description,
    durations: fields.durations,
    defaultDuration: fields.defaultDuration,
    locationType: fields.locationType,
    locationDetail: fields.locationDetail,
    scheduleId: fields.scheduleId,
    bufferBeforeMin: fields.bufferBeforeMin,
    bufferAfterMin: fields.bufferAfterMin,
    minNoticeMin: fields.minNoticeMin,
    maxPerDay: fields.maxPerDay,
    bookingWindowDays: fields.bookingWindowDays,
    slotIntervalMin: fields.slotIntervalMin,
    reminderOffsetsMin: fields.reminderOffsetsMin,
    isActive: fields.isActive,
    isListed: fields.isListed,
    brandAccent: fields.brandAccent,
    schedulingMode: fields.schedulingMode,
    rrStrategy: fields.rrStrategy,
    rrSticky: fields.rrSticky,
    hosts: fields.hosts,
  })
  .partial()
  .strict();

/** Which variant group a field belongs to; inherited groups are edited on the parent page. */
const FIELD_GROUP: Partial<Record<keyof z.infer<typeof updateEventTypeSchema>, VariantGroupKey>> = {
  description: "branding",
  brandAccent: "branding",
  durations: "durations",
  defaultDuration: "durations",
  locationType: "location",
  locationDetail: "location",
  bufferBeforeMin: "buffers",
  bufferAfterMin: "buffers",
  minNoticeMin: "buffers",
};

async function saveQuestions(tx: Tx, eventTypeId: string, questions: Question[]): Promise<void> {
  const keys = questions.map((q) => q.key);
  await tx`delete from app.event_type_questions where event_type_id = ${eventTypeId} and not (key = any(${keys}))`;
  for (const [i, q] of questions.entries()) {
    const label = { ...(q.label.en ? { en: q.label.en } : {}), ...(q.label.es ? { es: q.label.es } : {}) };
    const options =
      q.type === "dropdown"
        ? q.options.map((o) => ({ value: o.value, label: { ...(o.label.en ? { en: o.label.en } : {}), ...(o.label.es ? { es: o.label.es } : {}) } }))
        : [];
    await tx`
      insert into app.event_type_questions (event_type_id, key, type, label, options, required, position)
      values (${eventTypeId}, ${q.key}, ${q.type}, ${tx.json(label)}, ${tx.json(options)}, ${q.required}, ${i})
      on conflict (event_type_id, key) do update
        set type = excluded.type, label = excluded.label, options = excluded.options,
            required = excluded.required, position = excluded.position
    `;
  }
}

async function saveHosts(tx: Tx, eventTypeId: string, teamId: string, hosts: z.infer<typeof hostSchema>[]): Promise<void> {
  const ids = [...new Set(hosts.map((h) => h.teamMemberId))];
  if (ids.length) {
    const valid = await tx<{ id: string }[]>`select id from app.team_members where team_id = ${teamId} and id = any(${ids})`;
    if (valid.length !== ids.length) throw invalid("One of the hosts is not a member of this team.");
  }
  await tx`delete from app.event_type_hosts where event_type_id = ${eventTypeId}`;
  for (const h of hosts) {
    await tx`
      insert into app.event_type_hosts (event_type_id, team_member_id, is_required, weight_override, priority_tier_override)
      values (${eventTypeId}, ${h.teamMemberId}, ${h.isRequired}, ${h.weightOverride}, ${h.priorityTierOverride})
      on conflict do nothing
    `;
  }
}

function cleanDescription(d: { en?: string; es?: string }): Record<string, string> {
  return { ...(d.en ? { en: d.en } : {}), ...(d.es ? { es: d.es } : {}) };
}

export async function createEventType(caller: Caller, raw: unknown): Promise<EventTypeDetail> {
  const parsed = createEventTypeSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const v = parsed.data;
  if (v.ownerUserId && v.ownerUserId !== caller.user.id && !can(caller.user.role, "pages.manage_all")) {
    throw forbidden("Only admins can create booking pages for other users.");
  }
  const id = randomUUID();
  try {
    return await asCaller(caller, async (tx) => {
      if (v.teamId) {
        const [ok] = await tx<{ ok: boolean }[]>`select app.is_team_admin(${v.teamId}) as ok`;
        if (!ok?.ok) throw forbidden("You can only create booking pages for teams you manage.");
      }
      const ownerUserId = v.teamId ? null : (v.ownerUserId ?? caller.user.id);
      const defaultDuration = v.defaultDuration ?? v.durations[0];
      // No RETURNING: the SELECT policy cannot see a row inserted by the same statement.
      await tx`
        insert into app.event_types (
          id, owner_user_id, team_id, slug, language, name, description, durations, default_duration,
          location_type, location_detail, schedule_id, buffer_before_min, buffer_after_min, min_notice_min,
          max_per_day, booking_window_days, slot_interval_min, scheduling_mode, rr_strategy,
          rr_sticky_returning_invitee, reminder_offsets_min, is_active, is_listed, brand_accent
        ) values (
          ${id}, ${ownerUserId}, ${v.teamId ?? null}, ${v.slug}, ${v.language}, ${v.name}, ${tx.json(cleanDescription(v.description))},
          ${v.durations}, ${defaultDuration}, ${v.locationType}, ${v.locationDetail || null}, ${v.scheduleId},
          ${v.bufferBeforeMin}, ${v.bufferAfterMin}, ${v.minNoticeMin}, ${v.maxPerDay}, ${v.bookingWindowDays}, ${v.slotIntervalMin},
          ${v.teamId ? (v.schedulingMode ?? "round_robin") : "individual"}, ${v.rrStrategy},
          ${v.teamId ? v.rrSticky : false}, ${v.reminderOffsetsMin}, ${v.isActive}, ${v.isListed}, ${v.brandAccent}
        )
      `;
      await saveQuestions(tx, id, v.questions);
      if (v.teamId) await saveHosts(tx, id, v.teamId, v.hosts);
      await writeAudit(tx, {
        actorUserId: caller.user.id,
        action: "event_type.create",
        entityType: "event_type",
        entityId: id,
        after: { name: v.name, slug: v.slug, language: v.language, teamId: v.teamId ?? null, ownerUserId },
      });
      return loadDetail(tx, id);
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    mapDbError(err);
  }
}

export async function updateEventType(caller: Caller, id: string, raw: unknown): Promise<EventTypeDetail> {
  if (!uuid.safeParse(id).success) throw notFound("Booking page");
  const parsed = updateEventTypeSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const v = parsed.data;
  try {
    return await asCaller(caller, async (tx) => {
      const before = await loadDetail(tx, id);
      const [w] = await tx<{ ok: boolean }[]>`select app.can_write_event_type(${id}) as ok`;
      if (!w?.ok) throw forbidden("You cannot edit this booking page.");
      if (before.parentId) {
        const inherited = (Object.keys(v) as (keyof typeof v)[]).filter((k) => FIELD_GROUP[k] && !before.overrides.includes(FIELD_GROUP[k]!));
        if (inherited.length) throw invalid(`These fields are inherited from the parent page; edit the parent instead: ${inherited.join(", ")}.`);
        if (v.slug && v.slug !== before.slug) throw invalid("A variant uses its parent's slug.");
      }
      const next = {
        durations: v.durations ?? before.durations,
        defaultDuration: v.defaultDuration ?? (v.durations && !v.durations.includes(before.defaultDuration) ? v.durations[0] : before.defaultDuration),
        locationType: v.locationType ?? before.location.type,
        locationDetail: v.locationDetail === undefined ? before.location.detail : v.locationDetail,
      };
      if (!next.durations.includes(next.defaultDuration)) throw invalid("The default duration must be one of the durations.");
      if ((next.locationType === "in_person" || next.locationType === "custom") && !next.locationDetail) throw invalid("Describe the location.");
      if (v.hosts && before.owner.kind !== "team") throw invalid("Hosts apply to team pages only.");
      if (v.schedulingMode && before.owner.kind !== "team") throw invalid("Scheduling mode applies to team pages only.");

      await tx`
        update app.event_types set
          name = ${v.name ?? before.name},
          slug = ${v.slug ?? before.slug},
          description = ${tx.json(v.description ? cleanDescription(v.description) : before.description)},
          durations = ${next.durations},
          default_duration = ${next.defaultDuration},
          location_type = ${next.locationType},
          location_detail = ${next.locationDetail || null},
          schedule_id = ${v.scheduleId === undefined ? before.scheduleId : v.scheduleId},
          buffer_before_min = ${v.bufferBeforeMin ?? before.bufferBeforeMin},
          buffer_after_min = ${v.bufferAfterMin ?? before.bufferAfterMin},
          min_notice_min = ${v.minNoticeMin ?? before.minNoticeMin},
          max_per_day = ${v.maxPerDay === undefined ? before.maxPerDay : v.maxPerDay},
          booking_window_days = ${v.bookingWindowDays ?? before.bookingWindowDays},
          slot_interval_min = ${v.slotIntervalMin === undefined ? before.slotIntervalMin : v.slotIntervalMin},
          scheduling_mode = ${v.schedulingMode ?? before.schedulingMode},
          rr_strategy = ${v.rrStrategy ?? before.rrStrategy},
          rr_sticky_returning_invitee = ${before.owner.kind === "team" ? (v.rrSticky ?? before.rrSticky) : false},
          reminder_offsets_min = ${v.reminderOffsetsMin ?? before.reminderOffsetsMin},
          is_active = ${v.isActive ?? before.isActive},
          is_listed = ${v.isListed ?? before.isListed},
          brand_accent = ${v.brandAccent === undefined ? before.brandAccent : v.brandAccent},
          updated_at = now()
        where id = ${id}
      `;
      if (v.slug && v.slug !== before.slug && !before.parentId) {
        await tx`update app.event_types set slug = ${v.slug} where parent_event_type_id = ${id}`;
      }
      if (v.hosts && before.owner.kind === "team") await saveHosts(tx, id, before.owner.id, v.hosts);
      const after = await loadDetail(tx, id);
      const diff = changedFields(snapshot(before), snapshot(after));
      if (diff) await writeAudit(tx, { actorUserId: caller.user.id, action: "event_type.update", entityType: "event_type", entityId: id, ...diff });
      return after;
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    mapDbError(err);
  }
}

/** The audited view of a booking page: settings only, no question or host details. */
function snapshot(d: EventTypeDetail): Record<string, unknown> {
  return {
    name: d.name,
    slug: d.slug,
    description: d.description,
    durations: d.durations,
    defaultDuration: d.defaultDuration,
    location: d.location,
    scheduleId: d.scheduleId,
    bufferBeforeMin: d.bufferBeforeMin,
    bufferAfterMin: d.bufferAfterMin,
    minNoticeMin: d.minNoticeMin,
    maxPerDay: d.maxPerDay,
    bookingWindowDays: d.bookingWindowDays,
    slotIntervalMin: d.slotIntervalMin,
    schedulingMode: d.schedulingMode,
    rrStrategy: d.rrStrategy,
    rrSticky: d.rrSticky,
    reminderOffsetsMin: d.reminderOffsetsMin,
    isActive: d.isActive,
    isListed: d.isListed,
    brandAccent: d.brandAccent,
    hosts: d.hosts.map((h) => h.teamMemberId),
  };
}

export async function deleteEventType(caller: Caller, id: string): Promise<void> {
  if (!uuid.safeParse(id).success) throw notFound("Booking page");
  await asCaller(caller, async (tx) => {
    const [w] = await tx<{ ok: boolean }[]>`select app.can_write_event_type(${id}) as ok`;
    if (!w?.ok) throw notFound("Booking page");
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from app.bookings
      where event_type_id = ${id} or event_type_id in (select id from app.event_types where parent_event_type_id = ${id})
    `;
    if (n > 0) throw new ApiError(409, "has_bookings", "This booking page has bookings, so it cannot be deleted. Deactivate it instead.");
    const [row] = await tx<{ name: string }[]>`delete from app.event_types where id = ${id} returning name`;
    if (!row) throw notFound("Booking page");
    await writeAudit(tx, { actorUserId: caller.user.id, action: "event_type.delete", entityType: "event_type", entityId: id, before: { name: row.name } });
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const questionInput = z.object({
  key: z.string(),
  type: z.enum(["text", "textarea", "phone", "email", "dropdown", "checkbox"]),
  label: z.object({ en: z.string().optional(), es: z.string().optional() }),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.object({ en: z.string().optional(), es: z.string().optional() }) })).optional(),
});

/**
 * Replaces, adds, updates or removes questions on a booking page. The resulting list is
 * validated with the same rules as the editor, then saved and audited.
 */
export async function changeQuestions(
  caller: Caller,
  eventTypeId: string,
  op:
    | { kind: "replace"; questions: unknown }
    | { kind: "add"; question: unknown; position?: number }
    | { kind: "update"; key: string; changes: unknown }
    | { kind: "remove"; key: string },
): Promise<Question[]> {
  if (!uuid.safeParse(eventTypeId).success) throw notFound("Booking page");
  try {
    return await asCaller(caller, async (tx) => {
      const before = await loadDetail(tx, eventTypeId);
      const [w] = await tx<{ ok: boolean }[]>`select app.can_write_event_type(${eventTypeId}) as ok`;
      if (!w?.ok) throw forbidden("You cannot edit this booking page.");
      if (before.parentId && !before.overrides.includes("questions")) {
        throw invalid("This page inherits its questions from the parent page; edit the parent instead.");
      }
      let list: unknown[] = before.questions;
      if (op.kind === "replace") {
        list = Array.isArray(op.questions) ? op.questions : [];
      } else if (op.kind === "add") {
        const q = questionInput.safeParse(op.question);
        if (!q.success) throw invalid(q.error);
        const at = op.position === undefined ? list.length : Math.max(0, Math.min(list.length, op.position));
        list = [...list.slice(0, at), q.data, ...list.slice(at)];
      } else if (op.kind === "update") {
        const i = before.questions.findIndex((q) => q.key === op.key);
        if (i < 0) throw notFound("Question");
        const c = questionInput.partial().safeParse(op.changes);
        if (!c.success) throw invalid(c.error);
        const current = before.questions[i];
        list = before.questions.map((q, j) =>
          j === i ? { ...current, ...c.data, label: { ...current.label, ...(c.data.label ?? {}) }, options: c.data.options ?? current.options } : q,
        );
      } else {
        if (!before.questions.some((q) => q.key === op.key)) throw notFound("Question");
        list = before.questions.filter((q) => q.key !== op.key);
      }
      const parsed = questionsSchema.safeParse(list);
      if (!parsed.success) throw invalid(parsed.error);
      await saveQuestions(tx, eventTypeId, parsed.data);
      const diff = changedFields({ questions: before.questions }, { questions: parsed.data });
      if (diff) {
        await writeAudit(tx, { actorUserId: caller.user.id, action: "event_type.questions_update", entityType: "event_type", entityId: eventTypeId, ...diff });
      }
      return parsed.data;
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    mapDbError(err);
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const slotsQuerySchema = z.object({
  from: iso,
  to: iso,
  durationMin: z.number().int().min(5).max(480).optional(),
});

/** Open start times for an active booking page. Works for any active page, like the public page. */
export async function availableSlots(caller: Caller, eventTypeId: string, raw: unknown): Promise<{ start: string; end: string }[]> {
  if (!uuid.safeParse(eventTypeId).success) throw notFound("Booking page");
  const parsed = slotsQuerySchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const loaded = await loadEventTypeById(service(), eventTypeId);
  if (!loaded) throw notFound("Booking page");
  if (!loaded.active) {
    // Inactive pages have no public slots, but their owners and managers may still look.
    const visible = await asCaller(caller, async (tx) => (await tx<{ ok: boolean }[]>`select app.can_read_event_type(${eventTypeId}) as ok`)[0]?.ok);
    if (!visible) throw notFound("Booking page");
  }
  let durationMin: number;
  try {
    durationMin = pickDuration(loaded, parsed.data.durationMin);
  } catch (err) {
    if (err instanceof BookingValidationError) throw invalid("That duration is not offered on this booking page.");
    throw err;
  }
  return slotsFor(service(), loaded, { from: Date.parse(parsed.data.from), to: Date.parse(parsed.data.to), durationMin });
}

