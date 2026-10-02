import type { EventTypeQuestionRow, EventTypeRow } from "@/server/scheduling/resolve";
import type { EventTypeValues } from "./EventTypeForm";
import type { HostRow } from "./_data";

type Localized = { en?: string; es?: string };

export function toFormValues(et: EventTypeRow, questions: EventTypeQuestionRow[], hosts: HostRow[]): EventTypeValues {
  return {
    name: et.name,
    slug: et.slug,
    descriptionEn: et.description?.en ?? "",
    descriptionEs: et.description?.es ?? "",
    durations: et.durations,
    defaultDuration: et.default_duration,
    locationType: et.location_type,
    locationDetail: et.location_detail ?? "",
    scheduleId: et.schedule_id ?? "",
    bufferBefore: et.buffer_before_min,
    bufferAfter: et.buffer_after_min,
    minNotice: et.min_notice_min,
    maxPerDay: et.max_per_day,
    bookingWindowDays: et.booking_window_days,
    slotInterval: et.slot_interval_min,
    reminders: et.reminder_offsets_min,
    isActive: et.is_active,
    isListed: et.is_listed,
    brandAccent: et.brand_accent ?? "",
    questions: questions.map((q) => {
      const label = q.label as Localized;
      const options = (q.options as { value: string; label: Localized }[]).map((o) => ({ value: o.value, label: { en: o.label?.en ?? "", es: o.label?.es ?? "" } }));
      return { key: q.key, type: q.type, label: { en: label.en ?? "", es: label.es ?? "" }, required: q.required, options };
    }),
    schedulingMode: et.scheduling_mode === "collective" ? "collective" : "round_robin",
    rrStrategy: et.rr_strategy,
    rrSticky: et.rr_sticky_returning_invitee,
    hosts: hosts.map((h) => ({
      teamMemberId: h.team_member_id,
      isRequired: h.is_required,
      weightOverride: h.weight_override,
      priorityTierOverride: h.priority_tier_override,
    })),
  };
}

export const NEW_EVENT_TYPE: EventTypeValues = {
  name: "",
  slug: "",
  descriptionEn: "",
  descriptionEs: "",
  durations: [30],
  defaultDuration: 30,
  locationType: "teams",
  locationDetail: "",
  scheduleId: "",
  bufferBefore: 0,
  bufferAfter: 0,
  minNotice: 240,
  maxPerDay: null,
  bookingWindowDays: 30,
  slotInterval: null,
  reminders: [1440, 60],
  isActive: true,
  isListed: true,
  brandAccent: "",
  questions: [],
  schedulingMode: "round_robin",
  rrStrategy: "fairness",
  rrSticky: false,
  hosts: [],
};
