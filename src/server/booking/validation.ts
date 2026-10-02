/**
 * Server-side validation for public booking input. Pure (no I/O), so it is unit tested
 * directly. Every field from the browser goes through these schemas.
 */
import { IANAZone } from "luxon";
import { z } from "zod";
import { LOCALES } from "@/i18n/locales";
import type { EventTypeQuestionRow } from "@/server/scheduling";

export const LIMITS = {
  name: 120,
  email: 254,
  phone: 40,
  text: 500,
  textarea: 5000,
  cancelReason: 1000,
} as const;

/** Phone numbers: digits with optional +, spaces, dots, dashes and parentheses; 7 to 20 digits. */
export function isValidPhone(value: string): boolean {
  if (!/^\+?[0-9 ().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 20;
}

export function isValidTimezone(value: string): boolean {
  return value.length <= 64 && IANAZone.isValidZone(value);
}

const emailSchema = z
  .string()
  .trim()
  .max(LIMITS.email)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());

const phoneSchema = z.string().trim().max(LIMITS.phone).refine(isValidPhone, "invalid_phone");

/** Base64url manage token: 32 random bytes encode to 43 characters. */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const slugSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);

export const ownerRefSchema = z
  .string()
  .regex(/^(user|team):[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/)
  .transform((v) => {
    const [kind, slug] = v.split(":");
    return { kind: kind as "user" | "team", slug };
  });

export const isoInstantSchema = z.iso.datetime({ offset: true });

export const bookingRequestSchema = z.object({
  ref: ownerRefSchema,
  event: slugSchema,
  lang: z.enum(LOCALES),
  start: isoInstantSchema,
  duration: z.number().int().min(5).max(24 * 60),
  name: z.string().trim().min(1).max(LIMITS.name),
  email: emailSchema,
  phone: z.union([phoneSchema, z.literal(""), z.null()]).optional(),
  timezone: z.string().refine(isValidTimezone, "invalid_timezone"),
  answers: z.record(z.string().max(64), z.unknown()).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .nullish(),
  turnstileToken: z.string().max(2048).nullish(),
});

export type BookingRequest = z.infer<typeof bookingRequestSchema>;

/** The booking service's own input contract (createBooking validates with it again). */
export const bookingInputSchema = z.object({
  owner: z.object({ kind: z.enum(["user", "team"]), slug: slugSchema }),
  eventSlug: slugSchema,
  language: z.enum(LOCALES),
  start: isoInstantSchema,
  durationMin: z.number().int().min(5).max(24 * 60),
  name: z.string().trim().min(1).max(LIMITS.name),
  email: emailSchema,
  phone: z.union([z.string().max(LIMITS.phone), z.null()]).optional(),
  timezone: z.string().refine(isValidTimezone, "invalid_timezone"),
  answers: z.record(z.string().max(64), z.unknown()).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .nullish(),
});

/** Flattens zod issues to {field: code}. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_";
    if (!out[key]) out[key] = issue.message.startsWith("invalid_") ? issue.message : issue.code;
  }
  return out;
}

type DropdownOption = { value: string; label: Record<string, string> };

/** Parses question options defensively; malformed entries are ignored. */
export function parseOptions(options: unknown[]): DropdownOption[] {
  const out: DropdownOption[] = [];
  for (const o of options ?? []) {
    if (o && typeof o === "object" && typeof (o as DropdownOption).value === "string") {
      const label = (o as DropdownOption).label;
      out.push({
        value: (o as DropdownOption).value,
        label: label && typeof label === "object" ? label : { en: (o as DropdownOption).value },
      });
    }
  }
  return out;
}

/** The built-in phone field takes over a question keyed "phone". */
export const PHONE_QUESTION_KEY = "phone";

export type ValidatedAnswers = {
  answers: { questionId: string; key: string; value: string }[];
  /** Effective invitee phone (built-in field or the "phone" question). */
  phone: string | null;
};

/**
 * Validates custom question answers against the event type's resolved questions.
 * Returns field errors keyed by question key (and "phone" for the built-in field).
 */
export function validateAnswers(
  questions: EventTypeQuestionRow[],
  rawAnswers: Record<string, unknown> | undefined,
  rawPhone: string | null | undefined,
): { ok: true; value: ValidatedAnswers } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const answers: ValidatedAnswers["answers"] = [];
  const input = rawAnswers ?? {};
  const known = new Set(questions.map((q) => q.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors[key] = "unknown_question";
  }

  let phone: string | null = rawPhone ? rawPhone.trim() || null : null;
  const phoneQuestion = questions.find((q) => q.key === PHONE_QUESTION_KEY);
  if (phoneQuestion) {
    const fromAnswers = input[PHONE_QUESTION_KEY];
    if (!phone && typeof fromAnswers === "string" && fromAnswers.trim()) phone = fromAnswers.trim();
    if (phoneQuestion.required && !phone) errors.phone = "required";
  }
  if (phone && !isValidPhone(phone)) errors.phone = "invalid_phone";
  if (phone && phone.length > LIMITS.phone) errors.phone = "too_long";

  for (const q of [...questions].sort((a, b) => a.position - b.position)) {
    if (q.key === PHONE_QUESTION_KEY) {
      if (phone && !errors.phone) answers.push({ questionId: q.id, key: q.key, value: phone });
      continue;
    }
    const raw = input[q.key];
    if (q.type === "checkbox") {
      if (raw !== undefined && typeof raw !== "boolean") {
        errors[q.key] = "invalid";
        continue;
      }
      const checked = raw === true;
      if (q.required && !checked) errors[q.key] = "required";
      else answers.push({ questionId: q.id, key: q.key, value: checked ? "true" : "false" });
      continue;
    }
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      errors[q.key] = "invalid";
      continue;
    }
    const value = (raw ?? "").trim();
    if (!value) {
      if (q.required) errors[q.key] = "required";
      continue;
    }
    switch (q.type) {
      case "text":
        if (value.length > LIMITS.text) errors[q.key] = "too_long";
        break;
      case "textarea":
        if (value.length > LIMITS.textarea) errors[q.key] = "too_long";
        break;
      case "email":
        if (!emailSchema.safeParse(value).success) errors[q.key] = "invalid_email";
        break;
      case "phone":
        if (value.length > LIMITS.phone || !isValidPhone(value)) errors[q.key] = "invalid_phone";
        break;
      case "dropdown":
        if (!parseOptions(q.options).some((o) => o.value === value)) errors[q.key] = "invalid_option";
        break;
    }
    if (!errors[q.key]) {
      answers.push({
        questionId: q.id,
        key: q.key,
        value: q.type === "email" ? value.toLowerCase() : value,
      });
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { answers, phone } };
}

export const manageRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), token: tokenSchema }),
  z.object({
    action: z.literal("slots"),
    token: tokenSchema,
    from: isoInstantSchema,
    to: isoInstantSchema,
  }),
  z.object({
    action: z.literal("cancel"),
    token: tokenSchema,
    reason: z.string().trim().max(LIMITS.cancelReason).optional(),
    turnstileToken: z.string().max(2048).nullish(),
  }),
  z.object({
    action: z.literal("reschedule"),
    token: tokenSchema,
    start: isoInstantSchema,
    timezone: z.string().refine(isValidTimezone, "invalid_timezone").optional(),
    turnstileToken: z.string().max(2048).nullish(),
  }),
]);

export type ManageRequest = z.infer<typeof manageRequestSchema>;

export const slotsQuerySchema = z.object({
  ref: ownerRefSchema,
  event: slugSchema,
  lang: z.enum(LOCALES).default("en"),
  from: isoInstantSchema,
  to: isoInstantSchema,
  duration: z.coerce.number().int().min(5).max(24 * 60).optional(),
});
