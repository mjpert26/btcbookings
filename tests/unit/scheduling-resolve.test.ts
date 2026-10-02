import { describe, expect, it } from "vitest";
import { GROUP_FIELDS, INHERITABLE_GROUPS, overriddenGroups, resolveVariant } from "@/server/scheduling";
import type { EventTypeBundle, EventTypeQuestionRow, EventTypeRow } from "@/server/scheduling";

function row(patch: Partial<EventTypeRow> = {}): EventTypeRow {
  return {
    id: "parent",
    owner_user_id: null,
    team_id: "team-1",
    slug: "consult",
    language: "en",
    parent_event_type_id: null,
    overrides: [],
    name: "Consultation",
    description: { en: "Talk to us", es: "Hable con nosotros" },
    durations: [15, 30],
    default_duration: 30,
    location_type: "teams",
    location_detail: null,
    schedule_id: "sched-en",
    buffer_before_min: 5,
    buffer_after_min: 10,
    min_notice_min: 240,
    max_per_day: 8,
    booking_window_days: 30,
    slot_interval_min: null,
    scheduling_mode: "round_robin",
    rr_strategy: "fairness",
    rr_sticky_returning_invitee: false,
    reminder_offsets_min: [1440, 60],
    is_active: true,
    is_listed: true,
    brand_accent: "#0a4",
    ...patch,
  };
}

function question(id: string, eventTypeId: string, key: string): EventTypeQuestionRow {
  return {
    id,
    event_type_id: eventTypeId,
    key,
    type: "text",
    label: { en: key, es: key },
    options: [],
    required: true,
    position: 0,
  };
}

const parent: EventTypeBundle<string> = {
  eventType: row(),
  questions: [question("q1", "parent", "company")],
  sfSettings: {
    event_type_id: "parent",
    create_sf_lead: true,
    field_mapping: { invitee_email: "Email" },
    static_values: { Status: "Open" },
    campaign_id: "701xx",
    owner_mode: "assigned_host",
    owner_fixed_id: null,
  },
  hosts: ["tm-en-1", "tm-en-2"],
};

function child(patch: Partial<EventTypeRow> = {}, extra: Partial<EventTypeBundle<string>> = {}) {
  return {
    eventType: row({
      id: "child",
      language: "es",
      parent_event_type_id: "parent",
      name: "Consulta",
      description: { es: "Variante" },
      durations: [45],
      default_duration: 45,
      location_type: "phone",
      location_detail: "+1 555",
      schedule_id: "sched-es",
      buffer_before_min: 0,
      buffer_after_min: 0,
      min_notice_min: 60,
      max_per_day: 3,
      booking_window_days: 14,
      slot_interval_min: 20,
      rr_strategy: "weighted",
      rr_sticky_returning_invitee: true,
      is_listed: false,
      brand_accent: null,
      ...patch,
    }),
    questions: [question("q9", "child", "empresa")],
    sfSettings: null,
    hosts: ["tm-es-1"],
    ...extra,
  } satisfies EventTypeBundle<string>;
}

describe("resolveVariant", () => {
  it("exports the inheritable groups", () => {
    expect(INHERITABLE_GROUPS).toEqual(["sf_settings", "durations", "questions", "branding", "location", "buffers"]);
    expect(GROUP_FIELDS.buffers).toEqual(["buffer_before_min", "buffer_after_min", "min_notice_min"]);
  });

  it("returns a top-level event type unchanged with own provenance", () => {
    const resolved = resolveVariant(null, parent);
    expect(resolved.eventType).toEqual(parent.eventType);
    expect(resolved.parentId).toBeNull();
    expect(new Set(Object.values(resolved.provenance))).toEqual(new Set(["own"]));
    expect(new Set(Object.values(resolved.groups))).toEqual(new Set(["own"]));
    expect(resolved.questions).toBe(parent.questions);
  });

  it("inherits every group when nothing is overridden", () => {
    const resolved = resolveVariant(parent, child());
    const e = resolved.eventType;
    expect(e.durations).toEqual([15, 30]);
    expect(e.default_duration).toBe(30);
    expect(e.description).toEqual(parent.eventType.description);
    expect(e.brand_accent).toBe("#0a4");
    expect(e.location_type).toBe("teams");
    expect(e.location_detail).toBeNull();
    expect([e.buffer_before_min, e.buffer_after_min, e.min_notice_min]).toEqual([5, 10, 240]);
    expect(resolved.questions).toEqual(parent.questions);
    expect(resolved.sfSettings).toEqual(parent.sfSettings);
    expect(resolved.parentId).toBe("parent");
    for (const g of INHERITABLE_GROUPS) expect(resolved.groups[g]).toBe("inherited");
    expect(resolved.provenance.durations).toBe("inherited");
    expect(resolved.provenance.questions).toBe("inherited");
    expect(resolved.provenance.sf_settings).toBe("inherited");
  });

  it("always takes routing and identity fields from the child", () => {
    const resolved = resolveVariant(parent, child());
    const e = resolved.eventType;
    expect(e.id).toBe("child");
    expect(e.language).toBe("es");
    expect(e.slug).toBe("consult");
    expect(e.name).toBe("Consulta");
    expect(e.schedule_id).toBe("sched-es");
    expect(e.scheduling_mode).toBe("round_robin");
    expect(e.rr_strategy).toBe("weighted");
    expect(e.rr_sticky_returning_invitee).toBe(true);
    expect(e.max_per_day).toBe(3);
    expect(e.booking_window_days).toBe(14);
    expect(e.slot_interval_min).toBe(20);
    expect(e.is_listed).toBe(false);
    expect(e.parent_event_type_id).toBe("parent");
    expect(resolved.hosts).toEqual(["tm-es-1"]);
    for (const f of [
      "id",
      "name",
      "slug",
      "language",
      "schedule_id",
      "scheduling_mode",
      "rr_strategy",
      "rr_sticky_returning_invitee",
      "max_per_day",
      "booking_window_days",
      "slot_interval_min",
      "team_id",
      "owner_user_id",
      "is_active",
      "is_listed",
      "hosts",
    ] as const) {
      expect(resolved.provenance[f]).toBe("own");
    }
  });

  it("uses the child's values for overridden groups", () => {
    const resolved = resolveVariant(parent, child({ overrides: ["durations", "questions", "location", "buffers", "branding"] }));
    const e = resolved.eventType;
    expect(e.durations).toEqual([45]);
    expect(e.default_duration).toBe(45);
    expect(e.location_type).toBe("phone");
    expect(e.location_detail).toBe("+1 555");
    expect([e.buffer_before_min, e.buffer_after_min, e.min_notice_min]).toEqual([0, 0, 60]);
    expect(e.description).toEqual({ es: "Variante" });
    expect(e.brand_accent).toBeNull();
    expect(resolved.questions.map((q) => q.key)).toEqual(["empresa"]);
    expect(resolved.groups.durations).toBe("overridden");
    expect(resolved.provenance.default_duration).toBe("overridden");
    expect(resolved.provenance.brand_accent).toBe("overridden");
    expect(resolved.provenance.questions).toBe("overridden");
    // sf_settings not overridden and no own row: inherited.
    expect(resolved.groups.sf_settings).toBe("inherited");
    expect(resolved.sfSettings?.campaign_id).toBe("701xx");
  });

  it("mixes inherited and overridden groups", () => {
    const resolved = resolveVariant(parent, child({ overrides: ["location"] }));
    expect(resolved.eventType.location_type).toBe("phone");
    expect(resolved.eventType.durations).toEqual([15, 30]);
    expect(resolved.provenance.location_type).toBe("overridden");
    expect(resolved.provenance.durations).toBe("inherited");
  });

  it("treats a field name in overrides as overriding its whole group", () => {
    expect(overriddenGroups(["description", "buffer_after_min", "nonsense"])).toEqual(new Set(["branding", "buffers"]));
    const resolved = resolveVariant(parent, child({ overrides: ["default_duration"] }));
    expect(resolved.eventType.durations).toEqual([45]);
    expect(resolved.eventType.default_duration).toBe(45);
  });

  it("uses the child's own sf_settings row when present", () => {
    const own = { ...parent.sfSettings!, event_type_id: "child", campaign_id: "701es" };
    const resolved = resolveVariant(parent, child({}, { sfSettings: own }));
    expect(resolved.sfSettings?.campaign_id).toBe("701es");
    expect(resolved.provenance.sf_settings).toBe("overridden");
  });

  it("an sf_settings override with no own row disables lead creation", () => {
    const resolved = resolveVariant(parent, child({ overrides: ["sf_settings"] }));
    expect(resolved.sfSettings).toBeNull();
    expect(resolved.groups.sf_settings).toBe("overridden");
  });

  it("does not share mutable state with the parent", () => {
    const resolved = resolveVariant(parent, child());
    resolved.eventType.durations.push(99);
    resolved.questions[0].required = false;
    expect(parent.eventType.durations).toEqual([15, 30]);
    expect(parent.questions[0].required).toBe(true);
  });

  it("covers every event type column in the provenance map", () => {
    const resolved = resolveVariant(parent, child());
    for (const key of Object.keys(parent.eventType)) expect(resolved.provenance).toHaveProperty(key);
  });

  it("rejects a parent that is not the child's parent", () => {
    expect(() => resolveVariant({ ...parent, eventType: row({ id: "other" }) }, child())).toThrow(/not a variant/);
  });
});
