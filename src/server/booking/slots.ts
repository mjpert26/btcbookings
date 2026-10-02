import "server-only";
import { service, type Db } from "@/server/db/client";
import { generateSlots } from "@/server/scheduling";
import { loadAvailability, loadPool, loadPublicEventType, slotSettings, type LoadedEventType } from "@/server/booking/load";
import { BookingNotFoundError, BookingValidationError, type OwnerRef, type PublicSlot } from "@/server/booking/types";

/** Longest range one slots request may cover. */
export const MAX_SLOT_RANGE_DAYS = 62;
const DAY_MS = 86_400_000;

/** Validates the requested duration against the event type; defaults to the default duration. */
export function pickDuration(loaded: LoadedEventType, requested: number | undefined, allow?: number): number {
  const et = loaded.resolved.eventType;
  if (requested === undefined) return et.default_duration;
  if (et.durations.includes(requested) || requested === allow) return requested;
  throw new BookingValidationError({ duration: "invalid_duration" });
}

/** Slots for an already loaded event type. Returns ISO strings only. */
export async function slotsFor(
  db: Db,
  loaded: LoadedEventType,
  opts: { from: number; to: number; durationMin: number; now?: number; excludeBookingId?: string | null },
): Promise<PublicSlot[]> {
  if (!(opts.to > opts.from)) return [];
  const now = opts.now ?? Date.now();
  const from = Math.max(opts.from, now);
  const to = Math.min(opts.to, from + MAX_SLOT_RANGE_DAYS * DAY_MS);
  if (to <= from) return [];
  const pool = await loadPool(db, loaded);
  const ctx = await loadAvailability(db, loaded, pool, { from, to }, { excludeBookingId: opts.excludeBookingId });
  const et = loaded.resolved.eventType;
  const slots = generateSlots({
    mode: et.scheduling_mode,
    settings: slotSettings(et, opts.durationMin, ctx.schedule),
    hosts: ctx.hosts,
    now,
    from,
    to,
    eventBookingsPerDay: ctx.eventBookingsPerDay,
  });
  // Host ids are dropped here on purpose: the public API never reveals who is free.
  return slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));
}

/** Public slots API: available start/end pairs for an event type addressed by URL parts. */
export async function getAvailableSlots(
  ref: OwnerRef,
  eventSlug: string,
  language: string,
  opts: { from: Date; to: Date; duration?: number; now?: number },
  db: Db = service(),
): Promise<PublicSlot[]> {
  const loaded = await loadPublicEventType(db, ref, eventSlug, language);
  if (!loaded) throw new BookingNotFoundError();
  const durationMin = pickDuration(loaded, opts.duration);
  return slotsFor(db, loaded, {
    from: opts.from.getTime(),
    to: opts.to.getTime(),
    durationMin,
    now: opts.now,
  });
}
