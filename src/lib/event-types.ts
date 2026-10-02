import { z } from "zod";

/** Shared constants and validation for the event type editor (client and server). */

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
export const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const DURATION_CHOICES = [10, 15, 20, 25, 30, 45, 60, 75, 90, 120] as const;
export const REMINDER_CHOICES = [
  { value: 10080, label: "1 week before" },
  { value: 2880, label: "2 days before" },
  { value: 1440, label: "1 day before" },
  { value: 240, label: "4 hours before" },
  { value: 120, label: "2 hours before" },
  { value: 60, label: "1 hour before" },
  { value: 30, label: "30 minutes before" },
  { value: 15, label: "15 minutes before" },
] as const;

export const LOCATION_TYPES = [
  { value: "teams", label: "Microsoft Teams" },
  { value: "phone", label: "Phone call" },
  { value: "in_person", label: "In person" },
  { value: "custom", label: "Custom" },
] as const;

export const QUESTION_TYPES = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "dropdown", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
] as const;

export const RR_STRATEGIES = [
  { value: "fairness", label: "Fairness (fewest recent meetings first)" },
  { value: "weighted", label: "Weighted (by member weight)" },
  { value: "priority", label: "Priority tiers (lowest tier first)" },
] as const;

/** Variant groups, in display order, with the event type fields each one covers. */
export const VARIANT_GROUPS = [
  { key: "durations", label: "Durations", description: "Meeting lengths and the default length." },
  { key: "questions", label: "Questions", description: "Booking form questions." },
  { key: "location", label: "Location", description: "Where the meeting happens." },
  { key: "buffers", label: "Buffers and notice", description: "Time before and after, and minimum notice." },
  { key: "branding", label: "Branding and description", description: "Accent color and page description." },
  { key: "sf_settings", label: "Salesforce", description: "Lead creation settings (admins only)." },
] as const;

export type VariantGroupKey = (typeof VARIANT_GROUPS)[number]["key"];

const localized = z.object({
  en: z.string().trim().max(200, "Keep labels under 200 characters.").default(""),
  es: z.string().trim().max(200, "Keep labels under 200 characters.").default(""),
});

export const questionSchema = z
  .object({
    key: z.string().regex(QUESTION_KEY_RE, "Keys use lowercase letters, numbers and underscores, starting with a letter."),
    type: z.enum(["text", "textarea", "phone", "email", "dropdown", "checkbox"]),
    label: localized.refine((l) => l.en.length > 0 || l.es.length > 0, "Enter a label."),
    required: z.boolean().default(false),
    options: z
      .array(
        z.object({
          value: z.string().trim().min(1, "Option value is required.").max(100),
          label: localized.refine((l) => l.en.length > 0 || l.es.length > 0, "Enter an option label."),
        }),
      )
      .max(50)
      .default([]),
  })
  .superRefine((q, ctx) => {
    if (q.type === "dropdown" && q.options.length === 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Dropdowns need at least one option." });
    }
    const seen = new Set<string>();
    for (const o of q.options) {
      if (seen.has(o.value)) ctx.addIssue({ code: "custom", path: ["options"], message: `Duplicate option value "${o.value}".` });
      seen.add(o.value);
    }
  });

export type QuestionInput = z.input<typeof questionSchema>;
export type Question = z.output<typeof questionSchema>;

export const questionsSchema = z
  .array(questionSchema)
  .max(30, "At most 30 questions.")
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((q, i) => {
      if (seen.has(q.key)) ctx.addIssue({ code: "custom", path: [i, "key"], message: `Key "${q.key}" is used twice.` });
      seen.add(q.key);
    });
  });

export const hostSchema = z.object({
  teamMemberId: z.string().uuid(),
  isRequired: z.boolean().default(true),
  weightOverride: z.number().int().min(0).max(1000).nullable().default(null),
  priorityTierOverride: z.number().int().min(1).max(10).nullable().default(null),
});

export type HostInput = z.input<typeof hostSchema>;
