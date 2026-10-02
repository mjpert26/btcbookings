import type { NextRequest } from "next/server";
import { clientIp, hashIp } from "@/server/http/ip";
import { verifyTurnstile } from "@/server/http/turnstile";
import { cancelByInvitee, getBookingByToken, rescheduleByInvitee, rescheduleSlots } from "@/server/booking/manage";
import { bookingOptions } from "@/server/booking/providers";
import { manageRequestSchema } from "@/server/booking/validation";
import { json, jsonError, limit, mapBookingError, readJson, sameOrigin } from "@/server/booking/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/public/manage. Token-authenticated invitee actions:
 *   status      { token }                       -> Teams link polling on the confirmation page
 *   slots       { token, from, to }             -> reschedule calendar (own hold excluded)
 *   cancel      { token, reason?, turnstileToken }
 *   reschedule  { token, start, timezone?, turnstileToken } -> new token + booking
 * Tokens travel in the body, never in query strings.
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return jsonError(403, "forbidden");
  const ip = hashIp(req.headers);
  const parsed = manageRequestSchema.safeParse(await readJson(req, 8192));
  if (!parsed.success) return jsonError(400, "invalid");
  const body = parsed.data;

  const write = body.action === "cancel" || body.action === "reschedule";
  const limited = await limit(
    write
      ? [{ key: `manage:write:${ip}`, max: 10, windowSeconds: 600 }]
      : [{ key: `manage:read:${ip}`, max: 120, windowSeconds: 600 }],
  );
  if (limited) return limited;

  if (write) {
    const turnstile = await verifyTurnstile(body.turnstileToken, clientIp(req.headers));
    if (!turnstile.ok) return jsonError(400, "verification_failed");
  }

  try {
    switch (body.action) {
      case "status": {
        const view = await getBookingByToken(body.token);
        if (!view) return jsonError(404, "not_found");
        return json({ status: view.status, onlineMeetingUrl: view.onlineMeetingUrl });
      }
      case "slots": {
        const slots = await rescheduleSlots(body.token, { from: new Date(body.from), to: new Date(body.to) });
        return json({ slots });
      }
      case "cancel": {
        const booking = await cancelByInvitee(body.token, body.reason);
        return json({ booking });
      }
      case "reschedule": {
        const result = await rescheduleByInvitee(body.token, { start: body.start, timezone: body.timezone }, bookingOptions());
        return json({ token: result.token, booking: result.view });
      }
    }
  } catch (err) {
    return mapBookingError(err, "manage");
  }
}
