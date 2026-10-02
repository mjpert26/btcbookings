/**
 * Types for the pure scheduling engine (src/server/scheduling). No I/O happens in the
 * engine: callers load rows from the database and pass them in.
 */

/** "HH:mm" 24-hour local wall-clock time. */
export type WallTime = string;

export type Interval = { start: WallTime; end: WallTime };

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type WeeklyRules = Record<Weekday, Interval[]>;

export type DateOverride = {
  /** ISO date "YYYY-MM-DD" in the schedule's zone. */
  date: string;
  /** Empty array means unavailable all day. */
  intervals: Interval[];
};

export type Schedule = {
  timezone: string; // IANA
  weekly: WeeklyRules;
  overrides: DateOverride[];
};

/** A UTC instant range, half-open [start, end). Values are epoch milliseconds. */
export type Range = { start: number; end: number };

export type BusyBlock = Range & {
  showAs: string; // free | tentative | busy | oof | workingElsewhere | unknown
  isAllDay: boolean;
};

export type HostAvailabilityInput = {
  /** users.id */
  userId: string;
  /** team_members.id when the event type is a team event. */
  teamMemberId?: string;
  /** Outlook showAs values that block time for this host (user_settings.unavailable_show_as). */
  unavailableShowAs: string[];
  busy: BusyBlock[];
  /** Existing active bookings for this host, as blocked ranges (buffers already included). */
  booked: Range[];
  /** Counts of confirmed bookings per local date (host's zone) for daily caps. */
  bookingsPerDay: Record<string, number>;
  dailyCap: number | null;
  /** Host's IANA zone, used to evaluate daily caps and all-day events. */
  timezone: string;
  /** Host's own schedule; when null, the event type schedule applies. */
  schedule: Schedule | null;
  // Round-robin state
  weight: number;
  priorityTier: number;
  rrAssignmentCount: number;
  rrLastAssignedAt: number | null; // epoch ms
  isRequired: boolean; // collective
  eligible: boolean; // status active and calendar healthy (pre-computed by caller)
};

export type SlotSettings = {
  durationMin: number;
  slotIntervalMin: number; // defaults to duration (min 15) when not set on the event type
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  bookingWindowDays: number;
  maxPerDay: number | null; // event-type level cap, counted per host per local day
  /** Event type schedule (the default when hosts have none). */
  schedule: Schedule;
};

export type SchedulingMode = "individual" | "round_robin" | "collective";
export type RrStrategy = "fairness" | "weighted" | "priority";

export type Slot = {
  start: number; // epoch ms UTC
  end: number;
  /** userIds of hosts free for this slot (internal; never sent to the browser). */
  freeHostIds: string[];
};

export type GenerateSlotsInput = {
  mode: SchedulingMode;
  settings: SlotSettings;
  hosts: HostAvailabilityInput[];
  /** Current time, epoch ms. */
  now: number;
  /** Optional range to restrict generation (e.g. one month on the calendar view). */
  from?: number;
  to?: number;
  /** Event-type bookings per host per local date, for settings.maxPerDay. */
  eventBookingsPerDay?: Record<string, Record<string, number>>;
};

export type AssignmentInput = {
  strategy: RrStrategy;
  candidates: HostAvailabilityInput[]; // already filtered to free and eligible at the slot
  /** userId of the host to prefer (returning invitee or original host on reschedule). */
  preferredUserId?: string | null;
};
