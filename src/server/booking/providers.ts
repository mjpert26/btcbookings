import "server-only";
import type { BookingOptions, LiveBusyProvider } from "@/server/booking/types";
import { liveFreeBusy } from "@/server/graph/busy";

/** Adapts the Graph module's engine-shaped busy blocks (epoch ms) to the booking provider shape. */
const liveBusy: LiveBusyProvider = async (userIds, from, to) => {
  const byUser = await liveFreeBusy(userIds, from, to);
  return Object.fromEntries(
    Object.entries(byUser).map(([userId, blocks]) => [
      userId,
      blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end), showAs: b.showAs, isAllDay: b.isAllDay })),
    ]),
  );
};

/**
 * Runtime options for the public booking routes. The live Outlook pre-check reads
 * getSchedule for the candidate hosts; on timeout or error the booking falls back to
 * the cached busy blocks, so Graph problems never block a booking.
 */
export function bookingOptions(): BookingOptions {
  return { liveBusy, liveBusyTimeoutMs: 2000 };
}
