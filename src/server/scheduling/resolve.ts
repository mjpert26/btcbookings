/**
 * Variant resolution (PLAN 4.4). A variant (child) event type inherits grouped settings
 * from its parent unless the group is listed in child.overrides. Routing and identity
 * fields always come from the child. Pure: callers load rows and pass them in.
 */

export type EventTypeRow = {
  id: string;
  owner_user_id: string | null;
  team_id: string | null;
  slug: string;
  language: string;
  parent_event_type_id: string | null;
  overrides: string[];
  name: string;
  description: Record<string, string>;
  durations: number[];
  default_duration: number;
  location_type: "teams" | "phone" | "in_person" | "custom";
  location_detail: string | null;
  schedule_id: string | null;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  max_per_day: number | null;
  booking_window_days: number;
  slot_interval_min: number | null;
  scheduling_mode: "individual" | "round_robin" | "collective";
  rr_strategy: "fairness" | "weighted" | "priority";
  rr_sticky_returning_invitee: boolean;
  reminder_offsets_min: number[];
  is_active: boolean;
  is_listed: boolean;
  brand_accent: string | null;
};

export type EventTypeQuestionRow = {
  id: string;
  event_type_id: string;
  key: string;
  type: "text" | "textarea" | "phone" | "email" | "dropdown" | "checkbox";
  label: Record<string, string>;
  options: unknown[];
  required: boolean;
  position: number;
};

export type EventTypeSfSettingsRow = {
  event_type_id: string;
  create_sf_lead: boolean;
  field_mapping: Record<string, string>;
  static_values: Record<string, unknown>;
  campaign_id: string | null;
  owner_mode: "assigned_host" | "fixed" | "assignment_rules";
  owner_fixed_id: string | null;
};

/** An event type row together with its child rows. `hosts` is routing and never inherited. */
export type EventTypeBundle<H = unknown> = {
  eventType: EventTypeRow;
  questions: EventTypeQuestionRow[];
  sfSettings: EventTypeSfSettingsRow | null;
  hosts: H[];
};

export const INHERITABLE_GROUPS = [
  "sf_settings",
  "durations",
  "questions",
  "branding",
  "location",
  "buffers",
] as const;

export type InheritableGroup = (typeof INHERITABLE_GROUPS)[number];

/** Event type columns belonging to each inheritable group. */
export const GROUP_FIELDS = {
  sf_settings: [],
  durations: ["durations", "default_duration"],
  questions: [],
  branding: ["brand_accent", "description"],
  location: ["location_type", "location_detail"],
  buffers: ["buffer_before_min", "buffer_after_min", "min_notice_min"],
} as const satisfies Record<InheritableGroup, readonly (keyof EventTypeRow)[]>;

/**
 * inherited: value comes from the parent. overridden: the variant overrides the parent.
 * own: the field is not inheritable (routing or identity), or there is no parent.
 */
export type Provenance = "inherited" | "overridden" | "own";

export type ProvenanceField = keyof EventTypeRow | "questions" | "sf_settings" | "hosts";

export type ResolvedEventType<H = unknown> = EventTypeBundle<H> & {
  /** Parent id when this is a variant, otherwise null. */
  parentId: string | null;
  groups: Record<InheritableGroup, Provenance>;
  provenance: Record<ProvenanceField, Provenance>;
};

const FIELD_TO_GROUP = new Map<string, InheritableGroup>(
  INHERITABLE_GROUPS.flatMap((g) => GROUP_FIELDS[g].map((f) => [f, g] as const)),
);

/** Groups the child overrides. A field name in overrides marks its whole group. */
export function overriddenGroups(overrides: readonly string[]): Set<InheritableGroup> {
  const out = new Set<InheritableGroup>();
  for (const key of overrides) {
    if ((INHERITABLE_GROUPS as readonly string[]).includes(key)) out.add(key as InheritableGroup);
    const group = FIELD_TO_GROUP.get(key);
    if (group) out.add(group);
  }
  return out;
}

/**
 * Merges a variant with its parent. Pass parent = null for a top-level event type.
 * sf_settings: the child's own row (or "sf_settings" in overrides) wins; otherwise the
 * parent's row applies, matching "variants read the parent's row unless they have their own".
 */
export function resolveVariant<H>(
  parent: EventTypeBundle<unknown> | null,
  child: EventTypeBundle<H>,
): ResolvedEventType<H> {
  const row = child.eventType;
  const fields = Object.keys(row) as (keyof EventTypeRow)[];

  if (!parent) {
    const provenance = Object.fromEntries(
      [...fields, "questions", "sf_settings", "hosts"].map((f) => [f, "own"]),
    ) as Record<ProvenanceField, Provenance>;
    const groups = Object.fromEntries(INHERITABLE_GROUPS.map((g) => [g, "own"])) as Record<
      InheritableGroup,
      Provenance
    >;
    return { ...child, parentId: null, groups, provenance };
  }

  if (row.parent_event_type_id !== parent.eventType.id) {
    throw new Error(`Event type ${row.id} is not a variant of ${parent.eventType.id}`);
  }

  const overridden = overriddenGroups(row.overrides);
  if (child.sfSettings) overridden.add("sf_settings");

  const groups = Object.fromEntries(
    INHERITABLE_GROUPS.map((g) => [g, overridden.has(g) ? "overridden" : "inherited"]),
  ) as Record<InheritableGroup, Provenance>;

  const effective: EventTypeRow = { ...row };
  const provenance = {} as Record<ProvenanceField, Provenance>;
  for (const field of fields) {
    const group = FIELD_TO_GROUP.get(field);
    if (!group) {
      provenance[field] = "own";
      continue;
    }
    provenance[field] = groups[group];
    if (groups[group] === "inherited") {
      (effective as Record<string, unknown>)[field] = structuredClone(parent.eventType[field]);
    }
  }
  provenance.questions = groups.questions;
  provenance.sf_settings = groups.sf_settings;
  provenance.hosts = "own";

  return {
    eventType: effective,
    questions:
      groups.questions === "inherited" ? structuredClone(parent.questions) : child.questions,
    sfSettings:
      groups.sf_settings === "inherited" ? structuredClone(parent.sfSettings) : child.sfSettings,
    hosts: child.hosts,
    parentId: parent.eventType.id,
    groups,
    provenance,
  };
}
