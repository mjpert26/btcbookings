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

export const snapshotSchema = z.object({
  source: z.literal("calendly"),
  pulledAt: z.string(),
  members: z.array(
    z.object({
      uri,
      name: z.string().min(1),
      email: z.string().email(),
      slug: z.string().nullish(),
      timezone: z.string().nullish(),
    }),
  ),
  eventTypes: z.array(
    z.object({
      uri,
      name: z.string().min(1),
      slug: z.string().nullish(),
      active: z.boolean(),
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

/** Calendly allows several locations; the app has one, so the first one wins. */
export function mapLocation(locations: CalendlyEventType["locations"]): MappedLocation {
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
      return { type: "custom", detail: null, needsPhone: false };
    default:
      return { type: "custom", detail: first?.location ?? first?.additional_info ?? null, needsPhone: false };
  }
}

export type MappedQuestion = {
  key: string;
  type: "text" | "textarea" | "phone" | "email" | "dropdown" | "checkbox";
  label: string;
  options: { value: string; label: { en: string } }[];
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
export function mapQuestions(questions: CalendlyEventType["custom_questions"], needsPhone: boolean): MappedQuestion[] {
  const taken = new Set<string>();
  const out: MappedQuestion[] = [];
  const sorted = [...(questions ?? [])].filter((q) => q.enabled).sort((a, b) => a.position - b.position);
  for (const q of sorted) {
    const label = q.name.trim().slice(0, 300);
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
      options: type === "dropdown" ? choices.map((c) => ({ value: questionKey(c, optionKeys), label: { en: c } })) : [],
      required: q.required,
      position: out.length,
    });
  }
  if (needsPhone && !taken.has("phone")) {
    out.unshift({ key: "phone", type: "phone", label: "Phone number", options: [], required: true, position: -1 });
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
