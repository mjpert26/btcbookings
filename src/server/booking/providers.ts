import "server-only";
import type { BookingOptions } from "@/server/booking/types";

/**
 * Runtime options for the public booking routes.
 *
 * TODO(integrator): wire the live calendar pre-check once the Graph module is merged:
 *   import { liveFreeBusy } from "@/server/graph/busy";
 *   return { liveBusy: liveFreeBusy, liveBusyTimeoutMs: 2000 };
 * liveFreeBusy must match LiveBusyProvider in src/server/booking/types.ts.
 */
export function bookingOptions(): BookingOptions {
  return {};
}
