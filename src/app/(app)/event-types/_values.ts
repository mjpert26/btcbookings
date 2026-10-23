import type { EventTypeQuestionRow, EventTypeRow } from "@/server/scheduling/resolve";
import type { EventTypeValues } from "./EventTypeForm";
import type { HostRow } from "./_data";
import { DEFAULT_AGENT_CHANNELS, DEFAULT_AGENT_OFFSETS, DEFAULT_MERCHANT_CHANNELS } from "@/lib/reminders";

/** Reminder columns loaded with the event type row (see ET_COLUMNS in _data.ts). */
type ReminderColumns = {
  merchant_reminder_channels?: string[];
  agent_reminder_channels?: string[];
  agent_reminder_offsets_min?: number[];
};

type Localized = { en?: string; es?: string };

export function toFormValues(et: EventTypeRow, questions: EventTypeQuestionRow[], hosts: HostRow[]): EventTypeValues {
  const rem = et as EventTypeRow & ReminderColumns;
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
    merchantReminderChannels: rem.merchant_reminder_channels ?? [...DEFAULT_MERCHANT_CHANNELS],
    agentReminderChannels: rem.agent_reminder_channels ?? [...DEFAULT_AGENT_CHANNELS],
    agentReminders: rem.agent_reminder_offsets_min ?? [...DEFAULT_AGENT_OFFSETS],
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
  merchantReminderChannels: [...DEFAULT_MERCHANT_CHANNELS],
  agentReminderChannels: [...DEFAULT_AGENT_CHANNELS],
  agentReminders: [...DEFAULT_AGENT_OFFSETS],
  isActive: true,
  isListed: true,
  brandAccent: "",
  questions: [],
  schedulingMode: "round_robin",
  rrStrategy: "fairness",
  rrSticky: false,
  hosts: [],
};
