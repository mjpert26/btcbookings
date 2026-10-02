import type { NextRequest } from "next/server";
import { hashIp } from "@/server/http/ip";
import { getAvailableSlots } from "@/server/booking/slots";
import { slotsQuerySchema } from "@/server/booking/validation";
import { json, jsonError, limit, mapBookingError } from "@/server/booking/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/slots?ref=user:<slug>|team:<slug>&event=<slug>&lang=en|es&from=<iso>&to=<iso>&duration=<min>
 * Returns available slots as ISO start/end pairs. Never returns host identities.
 */
export async function GET(req: NextRequest) {
  const limited = await limit([{ key: `slots:${hashIp(req.headers)}`, max: 60, windowSeconds: 60 }]);
  if (limited) return limited;
  const parsed = slotsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return jsonError(400, "invalid");
  const q = parsed.data;
  try {
    const slots = await getAvailableSlots(q.ref, q.event, q.lang, {
      from: new Date(q.from),
      to: new Date(q.to),
      duration: q.duration,
    });
    return json({ slots });
  } catch (err) {
    return mapBookingError(err, "slots");
  }
}
