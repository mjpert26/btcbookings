import { z } from "zod";
import { slugify } from "@/server/auth/slug";

/**
 * Calendly snapshot format and the pure mapping from Calendly concepts to BTC Scheduler rows.
 * The snapshot is produced outside the app (Calendly API pulls) and contains only what the
 * import needs. Nothing in this file touches the database.
 */

const uri = z.string().url();

const question = z.object({
  name: z.string(),
  type: z.string(),
  position: z.number().int().default(0),
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  answer_choices: z.array(z.string()).nullish(),
});

const location = z.object({
  kind: z.string(),
  location: z.string().nullish(),
  phone_number: z.string().nullish(),
  additional_info: z.string().nullish(),
});

const availabilityRule = z.object({
  type: z.enum(["wday", "date"]),
  wday: z.string().nullish(),
  date: z.string().nullish(),
  intervals: z.array(z.object({ from: z.string(), to: z.string() })),
});

export const snapshotSchema = z.object({
  source: z.literal("calendly"),
  pulledAt: z.string(),
  /** Set by tooling that fills in made-up emails for local testing. Such a snapshot is never applied. */
  placeholder: z.boolean().optional(),
  /**
   * The start-time window the meetings were pulled for, including cancelled meetings. Imported
   * bookings in this window that are missing from the snapshot are treated as cancelled.
   */
  eventsWindow: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
  includesCanceled: z.literal(true),
  members: z.array(
    z.object({
      uri,
      name: z.string().min(1),
      email: z.string().email(),
      slug: z.string().nullish(),
      timezone: z.string().nullish(),
      /** The member's default Calendly availability schedule. */
      availability: z.object({ timezone: z.string().nullish(), rules: z.array(availabilityRule) }).nullish(),
    }),
  ),
  eventTypes: z.array(
    z.object({
      uri,
      name: z.string().min(1),
      slug: z.string().nullish(),
      active: z.boolean(),
      kind: z.enum(["solo", "group"]).nullish(),
      pooling_type: z.enum(["round_robin", "collective"]).nullish(),
      duration: z.number().int().positive(),
      duration_options: z.array(z.number().int().positive()).nullish(),
      description_plain: z.string().nullish(),
      secret: z.boolean().default(false),
      scheduling_url: z.string().url(),
      profile: z.object({ type: z.enum(["User", "Team"]), name: z.string(), owner: uri }),
      custom_questions: z.array(question).nullish(),
      locations: z.array(location).nullish(),
      /** Host user URIs for team event types, when known. */
      hosts: z.array(uri).nullish(),
      /** False when the host list may be incomplete (the source caps or fails the lookup). */
      hostsComplete: z.boolean().optional(),
    }),
  ),
  events: z.array(
    z.object({
      uri,
      status: z.enum(["active", "canceled"]),
      start_time: z.string(),
      end_time: z.string(),
      created_at: z.string().nullish(),
      event_type: uri,
      location: z
        .object({ type: z.string().nullish(), location: z.string().nullish(), join_url: z.string().nullish() })
        .nullish(),
      hosts: z.array(uri),
      /** The primary host's blocked time including Calendly buffers. */
      buffered_start_time: z.string().nullish(),
      buffered_end_time: z.string().nullish(),
      /** May be empty for cancelled meetings: a cancellation needs only the URI and status. */
      invitees: z.array(
        z.object({
          name: z.string().min(1),
          email: z.string().email(),
          timezone: z.string().nullish(),
          status: z.enum(["active", "canceled"]).default("active"),
          text_reminder_number: z.string().nullish(),
          questions_and_answers: z
            .array(z.object({ question: z.string(), answer: z.string().nullish(), position: z.number().int().default(0) }))
            .nullish(),
        }),
      ),
    }),
  ),
});

export type CalendlySnapshot = z.infer<typeof snapshotSchema>;
export type CalendlyEventType = CalendlySnapshot["eventTypes"][number];
export type CalendlyEvent = CalendlySnapshot["events"][number];

export const IMPORT_SOURCE = "calendly";

/** Field limits of the event type editor; imported rows must stay editable. */
export const LIMITS = { name: 120, questionLabel: 200, description: 2000 } as const;

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** A slug that satisfies the app's slug check, or the fallback when nothing usable remains. */
export function safeSlug(raw: string | null | undefined, fallback: string): string {
  const s = slugify(raw ?? "").slice(0, 64).replace(/-+$/g, "");
  return SLUG_RE.test(s) && s !== "user" ? s : fallback;
}

/** "aidan-miller-bigthinkcapital" -> "aidan-miller". */
export function userSlugFromCalendly(slug: string | null | undefined, name: string): string {
  const base = (slug ?? "").replace(/-?bigthinkcapital$/i, "");
  return safeSlug(base || name, safeSlug(name, "rep"));
}

/** The first and last path segments of a Calendly scheduling URL: owner slug and event slug. */
export function urlSegments(schedulingUrl: string): { owner: string; event: string | null } {
  const parts = new URL(schedulingUrl).pathname.split("/").filter(Boolean);
  return { owner: parts[0] ?? "", event: parts.length > 1 ? parts[parts.length - 1] : null };
}

export function languageFor(name: string): "en" | "es" {
  return /espa[ñn]ol|spanish/i.test(name) ? "es" : "en";
}

export type MappedLocation = { type: "teams" | "phone" | "in_person" | "custom"; detail: string | null; needsPhone: boolean };

const NO_LOCATION_DETAIL: Record<"en" | "es", string> = {
  en: "Your advisor will contact you with the meeting details.",
  es: "Su asesor se comunicará con usted con los detalles de la reunión.",
};

/** Calendly allows several locations; the app has one, so the first one wins. */
export function mapLocation(locations: CalendlyEventType["locations"], language: "en" | "es" = "en"): MappedLocation {
  const first = locations?.[0];
  switch (first?.kind) {
    case "microsoft_teams_conference":
      return { type: "teams", detail: null, needsPhone: false };
    case "outbound_call":
      // The host calls the invitee, so the invitee's number is required.
      return { type: "phone", detail: null, needsPhone: true };
    case "inbound_call":
      return { type: "phone", detail: first.phone_number ? `Call ${first.phone_number}` : null, needsPhone: false };
    case "physical":
      return { type: "in_person", detail: first.location ?? null, needsPhone: false };
    case undefined:
      // The editor requires a detail for custom locations.
      return { type: "custom", detail: NO_LOCATION_DETAIL[language], needsPhone: false };
    default:
      return { type: "custom", detail: first?.location ?? first?.additional_info ?? NO_LOCATION_DETAIL[language], needsPhone: false };
  }
}

export type MappedQuestion = {
  key: string;
  type: "text" | "textarea" | "phone" | "email" | "dropdown" | "checkbox";
  label: string;
  options: { value: string; label: Record<string, string> }[];
  required: boolean;
  position: number;
};

function questionKey(label: string, taken: Set<string>): string {
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `q_${base}`.replace(/_+$/g, "") || "q";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  taken.add(key);
  return key;
}

/** Enabled Calendly questions as app questions. Name and email are built in and not copied. */
export function mapQuestions(questions: CalendlyEventType["custom_questions"], needsPhone: boolean, language: "en" | "es" = "en"): MappedQuestion[] {
  const taken = new Set<string>();
  const out: MappedQuestion[] = [];
  const sorted = [...(questions ?? [])].filter((q) => q.enabled).sort((a, b) => a.position - b.position);
  for (const q of sorted) {
    const label = q.name.trim().slice(0, LIMITS.questionLabel);
    if (!label) continue;
    if (q.type === "phone_number" && !taken.has("phone")) {
      taken.add("phone");
      out.push({ key: "phone", type: "phone", label, options: [], required: q.required || needsPhone, position: out.length });
      continue;
    }
    const choices = (q.answer_choices ?? []).map((c) => c.trim()).filter(Boolean);
    const type: MappedQuestion["type"] =
      q.type === "text" ? "textarea" : q.type === "single_select" && choices.length ? "dropdown" : "text";
    const optionKeys = new Set<string>();
    out.push({
      key: questionKey(label, taken),
      type,
      label,
      options: type === "dropdown" ? choices.map((c) => ({ value: questionKey(c, optionKeys), label: { [language]: c } })) : [],
      required: q.required,
      position: out.length,
    });
  }
  if (needsPhone && !taken.has("phone")) {
    out.unshift({ key: "phone", type: "phone", label: language === "es" ? "Número de teléfono" : "Phone number", options: [], required: true, position: -1 });
  }
  return out.map((q, i) => ({ ...q, position: i }));
}

export function durationsFor(et: Pick<CalendlyEventType, "duration" | "duration_options">): { durations: number[]; defaultDuration: number } {
  const all = [...new Set([et.duration, ...(et.duration_options ?? [])])].sort((a, b) => a - b);
  return { durations: all, defaultDuration: et.duration };
}

/** Calendly event location as booking location fields. */
export function mapBookingLocation(
  loc: CalendlyEvent["location"],
  fallback: MappedLocation,
): { type: MappedLocation["type"]; detail: string | null; meetingUrl: string | null; inviteePhone: string | null } {
  switch (loc?.type) {
    case "microsoft_teams_conference":
      return { type: "teams", detail: null, meetingUrl: loc.join_url ?? null, inviteePhone: null };
    case "outbound_call":
      return { type: "phone", detail: null, meetingUrl: null, inviteePhone: loc.location ?? null };
    case "inbound_call":
      return { type: "phone", detail: loc.location ? `Call ${loc.location}` : fallback.detail, meetingUrl: null, inviteePhone: null };
    case "physical":
      return { type: "in_person", detail: loc.location ?? null, meetingUrl: null, inviteePhone: null };
    case null:
    case undefined:
      return { type: fallback.type, detail: fallback.detail, meetingUrl: null, inviteePhone: null };
    default:
      return { type: "custom", detail: loc?.location ?? null, meetingUrl: loc?.join_url ?? null, inviteePhone: null };
  }
}

/** Matches a Calendly answer to an imported question by its label. */
export function answerKey(question: string, questions: Pick<MappedQuestion, "key" | "label">[]): string | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return questions.find((q) => norm(q.label) === norm(question))?.key ?? null;
}

const WDAY: Record<string, "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

type WallInterval = { start: string; end: string };

function toIntervals(intervals: { from: string; to: string }[]): WallInterval[] {
  const out: WallInterval[] = [];
  for (const i of intervals) {
    // Calendly may express end of day as 24:00 or 00:00.
    const end = i.to === "24:00" || i.to === "00:00" ? "23:59" : i.to;
    if (!HHMM.test(i.from) || !HHMM.test(end) || i.from >= end) continue;
    out.push({ start: i.from, end });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Calendly availability rules as the app's weekly rules plus date overrides. Weekdays without a
 * rule are unavailable. Date overrides before `today` (YYYY-MM-DD) are dropped.
 */
export function mapAvailability(
  rules: { type: "wday" | "date"; wday?: string | null; date?: string | null; intervals: { from: string; to: string }[] }[],
  today: string,
): { weekly: Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", WallInterval[]>; overrides: { date: string; intervals: WallInterval[] }[] } {
  const weekly = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } as Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", WallInterval[]>;
  const overrides: { date: string; intervals: WallInterval[] }[] = [];
  for (const r of rules) {
    if (r.type === "wday") {
      const day = WDAY[(r.wday ?? "").toLowerCase()];
      if (day) weekly[day] = [...weekly[day], ...toIntervals(r.intervals)];
    } else if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= today) {
      overrides.push({ date: r.date, intervals: toIntervals(r.intervals) });
    }
  }
  return { weekly, overrides };
}

/**
 * The blocked range for an imported meeting: Calendly's buffered times when they enclose the
 * meeting, otherwise the meeting itself.
 */
export function blockedRange(ev: Pick<CalendlyEvent, "start_time" | "end_time" | "buffered_start_time" | "buffered_end_time">): string {
  const start = new Date(ev.start_time);
  const end = new Date(ev.end_time);
  const bs = ev.buffered_start_time ? new Date(ev.buffered_start_time) : start;
  const be = ev.buffered_end_time ? new Date(ev.buffered_end_time) : end;
  const ok = !Number.isNaN(bs.getTime()) && !Number.isNaN(be.getTime()) && bs <= start && be >= end;
  return `[${(ok ? bs : start).toISOString()},${(ok ? be : end).toISOString()})`;
}

/** True when Calendly considers the meeting cancelled. */
export function isCancelled(ev: Pick<CalendlyEvent, "status" | "invitees">): boolean {
  return ev.status === "canceled" || (ev.invitees.length > 0 && ev.invitees.every((i) => i.status === "canceled"));
}
