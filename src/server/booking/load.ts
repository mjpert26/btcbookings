import "server-only";
import { DateTime } from "luxon";
import type { Db } from "@/server/db/client";
import { isLocale, pickLocalized, type Locale } from "@/i18n/locales";
import {
  defaultSlotInterval,
  resolveVariant,
  type BusyBlock,
  type DateOverride,
  type EventTypeBundle,
  type EventTypeQuestionRow,
  type EventTypeRow,
  type EventTypeSfSettingsRow,
  type HostAvailabilityInput,
  type Interval,
  type Range,
  type ResolvedEventType,
  type Schedule,
  type SlotSettings,
  type Weekday,
  type WeeklyRules,
} from "@/server/scheduling";
import { parseOptions } from "@/server/booking/validation";
import type {
  LiveBusyBlock,
  OwnerRef,
  PublicEventCard,
  PublicEventType,
  PublicQuestion,
} from "@/server/booking/types";

/**
 * Loading for the public booking engine. Runs with the service connection (RLS bypassed),
 * so every query selects only the columns it needs, and only public-safe fields leave
 * this module through the Public* types.
 *
 * Availability model (documented decision):
 * - Individual event types: the event type's schedule_id, or the owner's default schedule
 *   when none is set. No second intersection is applied.
 * - Team event types: the event type's schedule (when set) intersected with each host's
 *   default user schedule. A team event without a schedule places no restriction of its
 *   own, so each host's working hours decide. A host with no default schedule uses the
 *   BTC default template (America/New_York, Mon-Fri 09:30-18:30).
 * - Host pool: active team members (status 'active') with an active app user. When the
 *   event type has event_type_hosts rows, only those members, with their weight and tier
 *   overrides. Paused and pending members are not in the pool at all, so they never
 *   block a collective event. Eligibility additionally requires a healthy calendar.
 * - Busy blocks that belong to the app's own bookings (busy_blocks.booking_id set) are
 *   ignored; active booking_hosts rows are authoritative for those.
 */

export type Owner =
  | { kind: "user"; id: string; slug: string; name: string; photoUrl: string | null; timezone: string }
  | { kind: "team"; id: string; slug: string; name: string; description: string | null };

export type EventHostRow = {
  team_member_id: string;
  is_required: boolean;
  weight_override: number | null;
  priority_tier_override: number | null;
};

export type LoadedEventType = {
  owner: Owner;
  /** The event type row that was addressed (the variant, when it is one). */
  resolved: ResolvedEventType<EventHostRow>;
};

/** Pool member with what the engine needs plus display data. */
export type PoolHost = {
  userId: string;
  teamMemberId: string | null;
  name: string;
  photoUrl: string | null;
  timezone: string;
  eligible: boolean;
  isRequired: boolean;
  weight: number;
  priorityTier: number;
  rrAssignmentCount: number;
  rrLastAssignedAt: number | null;
  dailyCap: number | null;
  unavailableShowAs: string[];
};

const DEFAULT_SHOW_AS = ["busy", "tentative", "oof"];
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_MS = 86_400_000;

const EVENT_COLUMNS = [
  "id", "owner_user_id", "team_id", "slug", "language", "parent_event_type_id", "overrides",
  "name", "description", "durations", "default_duration", "location_type", "location_detail",
  "schedule_id", "buffer_before_min", "buffer_after_min", "min_notice_min", "max_per_day",
  "booking_window_days", "slot_interval_min", "scheduling_mode", "rr_strategy",
  "rr_sticky_returning_invitee", "reminder_offsets_min", "is_active", "is_listed", "brand_accent",
] as const;

export const DEFAULT_TEMPLATE: Schedule = {
  timezone: "America/New_York",
  weekly: {
    mon: [{ start: "09:30", end: "18:30" }],
    tue: [{ start: "09:30", end: "18:30" }],
    wed: [{ start: "09:30", end: "18:30" }],
    thu: [{ start: "09:30", end: "18:30" }],
    fri: [{ start: "09:30", end: "18:30" }],
    sat: [],
    sun: [],
  },
  overrides: [],
};

const ALWAYS_OPEN: Schedule = {
  timezone: "UTC",
  weekly: Object.fromEntries(WEEKDAYS.map((d) => [d, [{ start: "00:00", end: "24:00" }]])) as WeeklyRules,
  overrides: [],
};

export async function findOwner(db: Db, ref: OwnerRef): Promise<Owner | null> {
  if (ref.kind === "user") {
    const [u] = await db<{ id: string; slug: string; name: string; photo_url: string | null; timezone: string }[]>`
      select id, slug, name, photo_url, timezone from app.users where slug = ${ref.slug} and is_active
    `;
    return u ? { kind: "user", id: u.id, slug: u.slug, name: u.name, photoUrl: u.photo_url, timezone: u.timezone } : null;
  }
  const [t] = await db<{ id: string; slug: string; name: string; description: string | null }[]>`
    select id, slug, name, description from app.teams where slug = ${ref.slug}
  `;
  return t ? { kind: "team", ...t } : null;
}

async function loadBundle(db: Db, row: EventTypeRow): Promise<EventTypeBundle<EventHostRow>> {
  const [questions, sf, hosts] = await Promise.all([
    db<EventTypeQuestionRow[]>`
      select id, event_type_id, key, type, label, options, required, position
      from app.event_type_questions where event_type_id = ${row.id} order by position, key
    `,
    db<EventTypeSfSettingsRow[]>`
      select event_type_id, create_sf_lead, field_mapping, static_values, campaign_id, owner_mode, owner_fixed_id
      from app.event_type_sf_settings where event_type_id = ${row.id}
    `,
    db<EventHostRow[]>`
      select team_member_id, is_required, weight_override, priority_tier_override
      from app.event_type_hosts where event_type_id = ${row.id}
    `,
  ]);
  return { eventType: row, questions: [...questions], sfSettings: sf[0] ?? null, hosts: [...hosts] };
}

async function eventRowById(db: Db, id: string): Promise<EventTypeRow | null> {
  const [row] = await db<EventTypeRow[]>`select ${db(EVENT_COLUMNS as unknown as string[])} from app.event_types where id = ${id}`;
  return row ?? null;
}

/** Resolves a row against its parent (when it is a variant). */
export async function resolveRow(db: Db, row: EventTypeRow): Promise<ResolvedEventType<EventHostRow>> {
  const child = await loadBundle(db, row);
  if (!row.parent_event_type_id) return resolveVariant(null, child);
  const parentRow = await eventRowById(db, row.parent_event_type_id);
  if (!parentRow) return resolveVariant(null, child);
  const parent = await loadBundle(db, parentRow);
  return resolveVariant(parent, child);
}

/**
 * Loads an active event type by public address. Secret (unlisted) event types are
 * returned too: they are reachable by direct URL, just not listed.
 */
export async function loadPublicEventType(
  db: Db,
  ref: OwnerRef,
  eventSlug: string,
  language: string,
): Promise<LoadedEventType | null> {
  if (!isLocale(language)) return null;
  const owner = await findOwner(db, ref);
  if (!owner) return null;
  const ownerCol = owner.kind === "user" ? db`owner_user_id` : db`team_id`;
  const [row] = await db<EventTypeRow[]>`
    select ${db(EVENT_COLUMNS as unknown as string[])} from app.event_types
    where ${ownerCol} = ${owner.id} and slug = ${eventSlug} and language = ${language} and is_active
  `;
  if (!row) return null;
  return { owner, resolved: await resolveRow(db, row) };
}

/** Loads an event type by id, for manage flows. Inactive types load too (callers decide). */
export async function loadEventTypeById(db: Db, id: string): Promise<(LoadedEventType & { active: boolean }) | null> {
  const row = await eventRowById(db, id);
  if (!row) return null;
  let owner: Owner | null;
  if (row.owner_user_id) {
    const [u] = await db<{ id: string; slug: string; name: string; photo_url: string | null; timezone: string }[]>`
      select id, slug, name, photo_url, timezone from app.users where id = ${row.owner_user_id}
    `;
    owner = u ? { kind: "user", id: u.id, slug: u.slug, name: u.name, photoUrl: u.photo_url, timezone: u.timezone } : null;
  } else {
    const [t] = await db<{ id: string; slug: string; name: string; description: string | null }[]>`
      select id, slug, name, description from app.teams where id = ${row.team_id}
    `;
    owner = t ? { kind: "team", ...t } : null;
  }
  if (!owner) return null;
  return { owner, resolved: await resolveRow(db, row), active: row.is_active };
}

export function eventPath(ownerKind: "user" | "team", ownerSlug: string, eventSlug: string, language: string): string {
  const base = ownerKind === "user" ? `/${ownerSlug}/${eventSlug}` : `/t/${ownerSlug}/${eventSlug}`;
  return language === "en" ? base : `${base}/${language}`;
}

/** Active counterpart variants (parent and children) in other languages. */
export async function loadAlternates(db: Db, loaded: LoadedEventType): Promise<{ language: Locale; path: string }[]> {
  const row = loaded.resolved.eventType;
  const familyRoot = row.parent_event_type_id ?? row.id;
  const rows = await db<{ language: string; slug: string }[]>`
    select language, slug from app.event_types
    where is_active and id <> ${row.id}
      and (id = ${familyRoot} or parent_event_type_id = ${familyRoot})
    order by language
  `;
  const seen = new Set<string>([row.language]);
  const out: { language: Locale; path: string }[] = [];
  for (const r of rows) {
    if (!isLocale(r.language) || seen.has(r.language) || r.slug !== row.slug) continue;
    seen.add(r.language);
    out.push({ language: r.language, path: eventPath(loaded.owner.kind, loaded.owner.slug, r.slug, r.language) });
  }
  return out;
}

export function publicQuestions(questions: EventTypeQuestionRow[], language: string): PublicQuestion[] {
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .map((q) => ({
      key: q.key,
      type: q.type,
      label: pickLocalized(q.label, language),
      required: q.required,
      options:
        q.type === "dropdown"
          ? parseOptions(q.options).map((o) => ({ value: o.value, label: pickLocalized(o.label, language) || o.value }))
          : [],
    }));
}

export async function toPublicEventType(db: Db, loaded: LoadedEventType): Promise<PublicEventType> {
  const et = loaded.resolved.eventType;
  const language = (isLocale(et.language) ? et.language : "en") as Locale;
  const owner = loaded.owner;
  return {
    ownerKind: owner.kind,
    ownerSlug: owner.slug,
    eventSlug: et.slug,
    language,
    name: et.name,
    description: pickLocalized(et.description, language),
    durations: [...et.durations].sort((a, b) => a - b),
    defaultDuration: et.default_duration,
    locationType: et.location_type,
    locationDetail: et.location_type === "teams" ? null : et.location_detail,
    schedulingMode: et.scheduling_mode,
    questions: publicQuestions(loaded.resolved.questions, language),
    host: owner.kind === "user" ? { name: owner.name, photoUrl: owner.photoUrl } : null,
    team: owner.kind === "team" ? { name: owner.name, description: owner.description } : null,
    alternates: await loadAlternates(db, loaded),
    path: eventPath(owner.kind, owner.slug, et.slug, language),
  };
}

/**
 * Listed, active event types for a user or team page. Each family (parent and variants)
 * appears once, in the requested language when that variant exists and is active.
 */
export async function listPublicEventTypes(
  db: Db,
  ref: OwnerRef,
  language: Locale,
): Promise<{ owner: Owner; events: PublicEventCard[]; languages: Locale[] } | null> {
  const owner = await findOwner(db, ref);
  if (!owner) return null;
  const ownerCol = owner.kind === "user" ? db`e.owner_user_id` : db`e.team_id`;
  const rows = await db<{
    id: string; parent_event_type_id: string | null; slug: string; language: string; name: string;
    description: Record<string, string>; durations: number[]; location_type: PublicEventType["locationType"];
    parent_durations: number[] | null; parent_description: Record<string, string> | null;
    parent_location_type: PublicEventType["locationType"] | null; overrides: string[];
  }[]>`
    select e.id, e.parent_event_type_id, e.slug, e.language, e.name, e.description, e.durations,
           e.location_type, e.overrides, p.durations as parent_durations,
           p.description as parent_description, p.location_type as parent_location_type
    from app.event_types e
    left join app.event_types p on p.id = e.parent_event_type_id
    where ${ownerCol} = ${owner.id} and e.is_active and e.is_listed
    order by e.name, e.language
  `;
  type Row = (typeof rows)[number];
  const families = new Map<string, Row[]>();
  for (const r of rows) {
    if (!isLocale(r.language)) continue;
    const key = r.parent_event_type_id ?? r.id;
    families.set(key, [...(families.get(key) ?? []), r]);
  }
  const events: PublicEventCard[] = [];
  for (const members of families.values()) {
    const pick =
      members.find((m) => m.language === language) ??
      members.find((m) => !m.parent_event_type_id) ??
      members[0];
    const inherits = (group: string, field: string) =>
      pick.parent_event_type_id && !pick.overrides.includes(group) && !pick.overrides.includes(field);
    const description = inherits("branding", "description") ? pick.parent_description ?? {} : pick.description;
    const durations = inherits("durations", "durations") ? pick.parent_durations ?? pick.durations : pick.durations;
    const locationType = inherits("location", "location_type")
      ? pick.parent_location_type ?? pick.location_type
      : pick.location_type;
    events.push({
      name: pick.name,
      description: pickLocalized(description, pick.language),
      durations: [...durations].sort((a, b) => a - b),
      locationType,
      language: pick.language as Locale,
      path: eventPath(owner.kind, owner.slug, pick.slug, pick.language),
    });
  }
  const languages = [...new Set(rows.map((r) => r.language).filter(isLocale))] as Locale[];
  return { owner, events, languages };
}

// ---------------------------------------------------------------------------
// Engine inputs
// ---------------------------------------------------------------------------

type PoolRow = {
  user_id: string;
  team_member_id: string | null;
  name: string;
  photo_url: string | null;
  timezone: string;
  calendar_status: string | null;
  weight: number;
  priority_tier: number;
  member_daily_cap: number | null;
  rr_assignment_count: number;
  rr_last_assigned_at: Date | null;
  unavailable_show_as: string[] | null;
  daily_booking_cap: number | null;
};

function minCap(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The host pool for an event type: the owner for individual events, otherwise active
 * team members (optionally restricted to event_type_hosts). Ordered for stable output.
 * Pass lockMembers inside the booking transaction to take FOR UPDATE row locks.
 */
export async function loadPool(db: Db, loaded: LoadedEventType, opts: { lockMembers?: boolean } = {}): Promise<PoolHost[]> {
  const et = loaded.resolved.eventType;
  let rows: PoolRow[];
  if (et.owner_user_id) {
    rows = await db<PoolRow[]>`
      select u.id as user_id, null::uuid as team_member_id, u.name, u.photo_url, u.timezone,
             cc.status::text as calendar_status, 1 as weight, 1 as priority_tier, null::int as member_daily_cap,
             0::bigint as rr_assignment_count, null::timestamptz as rr_last_assigned_at,
             us.unavailable_show_as, us.daily_booking_cap
      from app.users u
      left join app.calendar_connections cc on cc.user_id = u.id
      left join app.user_settings us on us.user_id = u.id
      where u.id = ${et.owner_user_id} and u.is_active
    `;
  } else {
    const subset = loaded.resolved.hosts;
    const ids = subset.map((h) => h.team_member_id);
    if (opts.lockMembers) {
      await db`
        select tm.id from app.team_members tm
        where tm.team_id = ${et.team_id} and tm.status = 'active' and tm.user_id is not null
          ${ids.length ? db`and tm.id = any(${ids}::uuid[])` : db``}
        order by tm.id
        for update
      `;
    }
    rows = await db<PoolRow[]>`
      select u.id as user_id, tm.id as team_member_id, u.name, u.photo_url, u.timezone,
             cc.status::text as calendar_status, tm.weight, tm.priority_tier, tm.daily_cap as member_daily_cap,
             tm.rr_assignment_count, tm.rr_last_assigned_at, us.unavailable_show_as, us.daily_booking_cap
      from app.team_members tm
      join app.users u on u.id = tm.user_id
      left join app.calendar_connections cc on cc.user_id = u.id
      left join app.user_settings us on us.user_id = u.id
      where tm.team_id = ${et.team_id} and tm.status = 'active' and u.is_active
        ${ids.length ? db`and tm.id = any(${ids}::uuid[])` : db``}
      order by tm.created_at, tm.id
    `;
  }
  const overrides = new Map(loaded.resolved.hosts.map((h) => [h.team_member_id, h]));
  return rows.map((r) => {
    const o = r.team_member_id ? overrides.get(r.team_member_id) : undefined;
    return {
      userId: r.user_id,
      teamMemberId: r.team_member_id,
      name: r.name,
      photoUrl: r.photo_url,
      timezone: r.timezone,
      eligible: r.calendar_status === "healthy",
      isRequired: o ? o.is_required : true,
      weight: o?.weight_override ?? r.weight,
      priorityTier: o?.priority_tier_override ?? r.priority_tier,
      rrAssignmentCount: Number(r.rr_assignment_count),
      rrLastAssignedAt: r.rr_last_assigned_at ? r.rr_last_assigned_at.getTime() : null,
      dailyCap: minCap(r.member_daily_cap, r.daily_booking_cap),
      unavailableShowAs: r.unavailable_show_as ?? DEFAULT_SHOW_AS,
    };
  });
}

function normalizeWeekly(raw: unknown): WeeklyRules {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(
    WEEKDAYS.map((d) => {
      const list = Array.isArray(src[d]) ? (src[d] as Interval[]) : [];
      return [d, list.filter((i) => i && typeof i.start === "string" && typeof i.end === "string")];
    }),
  ) as WeeklyRules;
}

async function loadSchedules(db: Db, ids: string[], from: number, to: number): Promise<Map<string, Schedule>> {
  const out = new Map<string, Schedule>();
  if (!ids.length) return out;
  const fromDate = DateTime.fromMillis(from - 2 * DAY_MS, { zone: "UTC" }).toISODate();
  const toDate = DateTime.fromMillis(to + 2 * DAY_MS, { zone: "UTC" }).toISODate();
  const [rows, overrides] = await Promise.all([
    db<{ id: string; timezone: string; weekly_rules: unknown }[]>`
      select id, timezone, weekly_rules from app.availability_schedules where id = any(${ids}::uuid[])
    `,
    db<{ schedule_id: string; date: string; intervals: Interval[] }[]>`
      select schedule_id, date::text as date, intervals from app.availability_overrides
      where schedule_id = any(${ids}::uuid[]) and date between ${fromDate}::date and ${toDate}::date
    `,
  ]);
  for (const r of rows) {
    const o: DateOverride[] = overrides
      .filter((x) => x.schedule_id === r.id)
      .map((x) => ({ date: x.date, intervals: Array.isArray(x.intervals) ? x.intervals : [] }));
    out.set(r.id, { timezone: r.timezone, weekly: normalizeWeekly(r.weekly_rules), overrides: o });
  }
  return out;
}

export type AvailabilityContext = {
  pool: PoolHost[];
  hosts: HostAvailabilityInput[];
  schedule: Schedule;
  eventBookingsPerDay: Record<string, Record<string, number>>;
};

/**
 * Builds engine inputs for [from, to). Busy data is loaded with a two-day margin so that
 * buffers and per-day caps at the edges are evaluated correctly.
 */
export async function loadAvailability(
  db: Db,
  loaded: LoadedEventType,
  pool: PoolHost[],
  range: { from: number; to: number },
  opts: { liveBusy?: Record<string, LiveBusyBlock[]> | null; excludeBookingId?: string | null } = {},
): Promise<AvailabilityContext> {
  const et = loaded.resolved.eventType;
  const userIds = pool.map((p) => p.userId);
  const marginFrom = new Date(range.from - 2 * DAY_MS);
  const marginTo = new Date(range.to + 2 * DAY_MS);

  const defaultScheduleRows = userIds.length
    ? await db<{ id: string; owner_user_id: string }[]>`
        select id, owner_user_id from app.availability_schedules
        where owner_user_id = any(${userIds}::uuid[]) and is_default
      `
    : [];
  const defaultByUser = new Map(defaultScheduleRows.map((r) => [r.owner_user_id, r.id]));
  const scheduleIds = [...new Set([...(et.schedule_id ? [et.schedule_id] : []), ...defaultByUser.values()])];

  const [schedules, busyRows, bookedRows] = await Promise.all([
    loadSchedules(db, scheduleIds, range.from, range.to),
    userIds.length
      ? db<{ user_id: string; start_at: Date; end_at: Date; show_as: string; is_all_day: boolean }[]>`
          select user_id, start_at, end_at, show_as, is_all_day from app.busy_blocks
          where user_id = any(${userIds}::uuid[]) and booking_id is null
            and start_at < ${marginTo} and end_at > ${marginFrom}
        `
      : Promise.resolve([]),
    userIds.length
      ? db<{ user_id: string; lo: Date; hi: Date; start_at: Date; event_type_id: string; booking_id: string }[]>`
          select bh.user_id, lower(bh.blocked_range) as lo, upper(bh.blocked_range) as hi,
                 b.start_at, b.event_type_id, b.id as booking_id
          from app.booking_hosts bh join app.bookings b on b.id = bh.booking_id
          where bh.active and bh.user_id = any(${userIds}::uuid[])
            and bh.blocked_range && tstzrange(${marginFrom}, ${marginTo})
        `
      : Promise.resolve([]),
  ]);

  let schedule: Schedule;
  if (et.schedule_id && schedules.has(et.schedule_id)) schedule = schedules.get(et.schedule_id)!;
  else if (et.owner_user_id) {
    const own = defaultByUser.get(et.owner_user_id);
    schedule = (own && schedules.get(own)) || DEFAULT_TEMPLATE;
  } else schedule = ALWAYS_OPEN;

  const eventBookingsPerDay: Record<string, Record<string, number>> = {};
  const hosts: HostAvailabilityInput[] = pool.map((p) => {
    const busy: BusyBlock[] = busyRows
      .filter((b) => b.user_id === p.userId)
      .map((b) => ({ start: b.start_at.getTime(), end: b.end_at.getTime(), showAs: b.show_as, isAllDay: b.is_all_day }));
    for (const live of opts.liveBusy?.[p.userId] ?? []) {
      busy.push({ start: live.start.getTime(), end: live.end.getTime(), showAs: live.showAs, isAllDay: !!live.isAllDay });
    }
    const booked: Range[] = [];
    const perDay: Record<string, number> = {};
    const eventPerDay: Record<string, number> = {};
    for (const b of bookedRows) {
      if (b.user_id !== p.userId || b.booking_id === opts.excludeBookingId) continue;
      booked.push({ start: b.lo.getTime(), end: b.hi.getTime() });
      const day = DateTime.fromJSDate(b.start_at, { zone: p.timezone }).toISODate()!;
      perDay[day] = (perDay[day] ?? 0) + 1;
      if (b.event_type_id === et.id) eventPerDay[day] = (eventPerDay[day] ?? 0) + 1;
    }
    eventBookingsPerDay[p.userId] = eventPerDay;
    let hostSchedule: Schedule | null = null;
    if (!et.owner_user_id) {
      const own = defaultByUser.get(p.userId);
      hostSchedule = (own && schedules.get(own)) || DEFAULT_TEMPLATE;
    }
    return {
      userId: p.userId,
      teamMemberId: p.teamMemberId ?? undefined,
      unavailableShowAs: p.unavailableShowAs,
      busy,
      booked,
      bookingsPerDay: perDay,
      dailyCap: p.dailyCap,
      timezone: p.timezone,
      schedule: hostSchedule,
      weight: p.weight,
      priorityTier: p.priorityTier,
      rrAssignmentCount: p.rrAssignmentCount,
      rrLastAssignedAt: p.rrLastAssignedAt,
      isRequired: p.isRequired,
      eligible: p.eligible,
    };
  });

  return { pool, hosts, schedule, eventBookingsPerDay };
}

export function slotSettings(et: EventTypeRow, durationMin: number, schedule: Schedule): SlotSettings {
  return {
    durationMin,
    slotIntervalMin: defaultSlotInterval(durationMin, et.slot_interval_min),
    bufferBeforeMin: et.buffer_before_min,
    bufferAfterMin: et.buffer_after_min,
    minNoticeMin: et.min_notice_min,
    bookingWindowDays: et.booking_window_days,
    maxPerDay: et.max_per_day,
    schedule,
  };
}
