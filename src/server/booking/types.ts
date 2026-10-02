/**
 * Shared types for the public booking service (src/server/booking). Nothing here is sent
 * to the browser as-is: public-facing shapes are the *Public* types below.
 */
import type { Locale } from "@/i18n/locales";

/** A busy interval reported by a live calendar lookup (Graph getSchedule). */
export type LiveBusyBlock = {
  start: Date;
  end: Date;
  /** Outlook showAs value (busy, tentative, oof, workingElsewhere, free, unknown). */
  showAs: string;
  isAllDay?: boolean;
};

/**
 * Optional pre-check against live calendars, called before the booking transaction.
 * Returns busy blocks per user id. The booking service merges them with the cached
 * busy_blocks for the in-transaction availability check. Throwing, or not answering
 * within the service's timeout, falls back to the cache only.
 *
 * Integration point: the Graph module's `liveFreeBusy` (src/server/graph/busy) is
 * expected to satisfy this signature.
 */
export type LiveBusyProvider = (
  userIds: string[],
  from: Date,
  to: Date,
) => Promise<Record<string, LiveBusyBlock[]>>;

/** How a public URL addresses an event type owner. */
export type OwnerRef = { kind: "user"; slug: string } | { kind: "team"; slug: string };

export type PublicQuestion = {
  key: string;
  type: "text" | "textarea" | "phone" | "email" | "dropdown" | "checkbox";
  label: string;
  required: boolean;
  options: { value: string; label: string }[];
};

/** Public-safe event type data for booking pages. */
export type PublicEventType = {
  ownerKind: "user" | "team";
  ownerSlug: string;
  eventSlug: string;
  language: Locale;
  name: string;
  description: string;
  durations: number[];
  defaultDuration: number;
  locationType: "teams" | "phone" | "in_person" | "custom";
  /** Shown for phone, in-person and custom locations; never for Teams. */
  locationDetail: string | null;
  schedulingMode: "individual" | "round_robin" | "collective";
  questions: PublicQuestion[];
  /** Individual pages only. */
  host: { name: string; photoUrl: string | null } | null;
  /** Team pages only. */
  team: { name: string; description: string | null } | null;
  /** Counterpart language variants that are active, for the language switcher. */
  alternates: { language: Locale; path: string }[];
  path: string;
};

export type PublicEventCard = {
  name: string;
  description: string;
  durations: number[];
  locationType: PublicEventType["locationType"];
  path: string;
  language: Locale;
};

export type PublicSlot = { start: string; end: string };

export type BookingStatusPublic = "confirmed" | "cancelled" | "rescheduled";

/** What the invitee sees on /b/[token]. No ids, no emails of hosts, no internal flags. */
export type PublicBookingView = {
  status: BookingStatusPublic;
  isPast: boolean;
  start: string;
  end: string;
  durationMin: number;
  language: Locale;
  eventName: string;
  eventPath: string | null;
  inviteeName: string;
  inviteeTimezone: string;
  hosts: { name: string; photoUrl: string | null }[];
  locationType: PublicEventType["locationType"];
  locationDetail: string | null;
  onlineMeetingUrl: string | null;
  canCancel: boolean;
  canReschedule: boolean;
  /** Last date the reschedule calendar may show (ISO). */
  windowEnd: string | null;
  createdAt: string;
};

export type BookingInput = {
  owner: OwnerRef;
  eventSlug: string;
  /** Variant language of the page that was booked. */
  language: string;
  start: string;
  durationMin: number;
  name: string;
  email: string;
  phone?: string | null;
  timezone: string;
  answers?: Record<string, unknown>;
  idempotencyKey?: string | null;
};

export type BookingOptions = {
  liveBusy?: LiveBusyProvider;
  /** Milliseconds to wait for liveBusy before falling back to the cache. */
  liveBusyTimeoutMs?: number;
  /** Clock override for tests (epoch ms). */
  now?: number;
};

export type BookingResult = {
  /** The manage token. Returned once; only its hash and an encrypted copy are stored. */
  token: string;
  view: PublicBookingView;
  /** True when an idempotent retry returned an existing booking. */
  replayed: boolean;
};

export class BookingError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid"
      | "slot_taken"
      | "not_allowed",
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/** The requested slot is no longer available (or was never available). */
export class SlotTakenError extends BookingError {
  constructor(message = "The selected time is no longer available") {
    super("slot_taken", message);
    this.name = "SlotTakenError";
  }
}

export class BookingValidationError extends BookingError {
  constructor(fieldErrors: Record<string, string>) {
    super("invalid", "Booking input is invalid", fieldErrors);
    this.name = "BookingValidationError";
  }
}

export class BookingNotFoundError extends BookingError {
  constructor() {
    super("not_found", "Not found");
    this.name = "BookingNotFoundError";
  }
}
