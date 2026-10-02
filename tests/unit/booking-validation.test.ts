import { describe, expect, it } from "vitest";
import {
  bookingInputSchema,
  bookingRequestSchema,
  fieldErrors,
  isValidPhone,
  isValidTimezone,
  manageRequestSchema,
  ownerRefSchema,
  slotsQuerySchema,
  validateAnswers,
} from "@/server/booking/validation";
import type { EventTypeQuestionRow } from "@/server/scheduling";

const q = (over: Partial<EventTypeQuestionRow>): EventTypeQuestionRow => ({
  id: `q-${over.key}`,
  event_type_id: "e",
  key: "k",
  type: "text",
  label: { en: "Label", es: "Etiqueta" },
  options: [],
  required: false,
  position: 0,
  ...over,
});

const base = {
  owner: { kind: "user" as const, slug: "dana" },
  eventSlug: "intro",
  language: "en" as const,
  start: "2026-10-05T15:00:00.000Z",
  durationMin: 30,
  name: "Pat",
  email: "Pat@Example.com",
  timezone: "America/Chicago",
};

describe("booking input schema", () => {
  it("accepts valid input and lowercases the email", () => {
    const r = bookingInputSchema.parse(base);
    expect(r.email).toBe("pat@example.com");
  });

  it.each([
    ["timezone", { timezone: "Not/AZone" }],
    ["email", { email: "nope" }],
    ["name", { name: "" }],
    ["name", { name: "x".repeat(121) }],
    ["start", { start: "tomorrow" }],
    ["language", { language: "fr" }],
    ["owner", { owner: { kind: "user", slug: "Bad Slug" } }],
    ["idempotencyKey", { idempotencyKey: "short" }],
  ])("rejects a bad %s", (field, over) => {
    const r = bookingInputSchema.safeParse({ ...base, ...over });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrors(r.error)).join(",")).toContain(field);
  });

  it("parses owner refs and API bodies", () => {
    expect(ownerRefSchema.parse("team:sales-team")).toEqual({ kind: "team", slug: "sales-team" });
    expect(ownerRefSchema.safeParse("org:x").success).toBe(false);
    expect(
      bookingRequestSchema.safeParse({
        ref: "user:dana",
        event: "intro",
        lang: "es",
        start: base.start,
        duration: 30,
        name: "Pat",
        email: "pat@example.com",
        timezone: "UTC",
      }).success,
    ).toBe(true);
    expect(slotsQuerySchema.safeParse({ ref: "user:dana", event: "intro", from: base.start, to: base.start }).success).toBe(true);
    expect(manageRequestSchema.safeParse({ action: "cancel", token: "x" }).success).toBe(false);
    expect(manageRequestSchema.safeParse({ action: "cancel", token: "a".repeat(43) }).success).toBe(true);
    expect(manageRequestSchema.safeParse({ action: "delete", token: "a".repeat(43) }).success).toBe(false);
  });

  it("validates phones and zones", () => {
    expect(isValidPhone("+1 (305) 555-0100")).toBe(true);
    expect(isValidPhone("555")).toBe(false);
    expect(isValidPhone("call me")).toBe(false);
    expect(isValidTimezone("America/Bogota")).toBe(true);
    expect(isValidTimezone("EST5EDT; drop table")).toBe(false);
  });
});

describe("validateAnswers", () => {
  const questions = [
    q({ key: "company", required: true, position: 1 }),
    q({ key: "notes", type: "textarea", position: 2 }),
    q({ key: "size", type: "dropdown", options: [{ value: "s", label: { en: "S" } }, { value: "l", label: { en: "L" } }], position: 3 }),
    q({ key: "cc", type: "email", position: 4 }),
    q({ key: "alt_phone", type: "phone", position: 5 }),
    q({ key: "agree", type: "checkbox", required: true, position: 6 }),
  ];

  it("accepts valid answers and normalizes them", () => {
    const r = validateAnswers(questions, { company: " Acme ", size: "l", cc: "A@B.co", agree: true, alt_phone: "305 555 0100" }, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.answers.map((a) => [a.key, a.value])).toEqual([
        ["company", "Acme"],
        ["size", "l"],
        ["cc", "a@b.co"],
        ["alt_phone", "305 555 0100"],
        ["agree", "true"],
      ]);
      expect(r.value.phone).toBeNull();
    }
  });

  it("reports every problem by field", () => {
    const r = validateAnswers(
      questions,
      { notes: "x".repeat(5001), size: "m", cc: "bad", alt_phone: "12", agree: "yes", bogus: 1 },
      "abc",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual({
        company: "required",
        notes: "too_long",
        size: "invalid_option",
        cc: "invalid_email",
        alt_phone: "invalid_phone",
        agree: "invalid",
        bogus: "unknown_question",
        phone: "invalid_phone",
      });
    }
  });

  it("maps a required 'phone' question onto the built-in phone field", () => {
    const qs = [q({ key: "phone", type: "phone", required: true })];
    expect(validateAnswers(qs, {}, null)).toEqual({ ok: false, errors: { phone: "required" } });
    const r = validateAnswers(qs, {}, "+52 55 1234 5678");
    expect(r).toEqual({ ok: true, value: { phone: "+52 55 1234 5678", answers: [{ questionId: "q-phone", key: "phone", value: "+52 55 1234 5678" }] } });
  });
});
