import type { NextRequest } from "next/server";
import { clientIp, hashIp } from "@/server/http/ip";
import { verifyTurnstile } from "@/server/http/turnstile";
import { createBooking } from "@/server/booking/create";
import { bookingOptions } from "@/server/booking/providers";
import { bookingRequestSchema, fieldErrors } from "@/server/booking/validation";
import { emailKey, json, jsonError, limit, mapBookingError, readJson, sameOrigin } from "@/server/booking/http";

export const dynamic = "force-dynamic";

const PAGE_DAILY_MAX = 300;
const GLOBAL_DAILY_MAX = 2000;

/**
 * POST /api/public/book. Creates a booking and returns the manage token (the only
 * handle the invitee gets) plus public display data. No booking ids are returned.
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return jsonError(403, "forbidden");
  const ip = hashIp(req.headers);
  const ipLimited = await limit([{ key: `book:ip:${ip}`, max: 10, windowSeconds: 600 }]);
  if (ipLimited) return ipLimited;

  const parsed = bookingRequestSchema.safeParse(await readJson(req));
  if (!parsed.success) return jsonError(400, "invalid", { fields: fieldErrors(parsed.error) });
  const body = parsed.data;

  const emailLimited = await limit([{ key: `book:email:${emailKey(body.email)}`, max: 5, windowSeconds: 600 }]);
  if (emailLimited) return emailLimited;

  const turnstile = await verifyTurnstile(body.turnstileToken, clientIp(req.headers));
  if (!turnstile.ok) return jsonError(400, "verification_failed");

  // Volume ceiling per booking page and overall, after Turnstile, so a scripted flood cannot
  // turn host mailboxes into an invite relay. Far above BTC's normal daily volume.
  const pageKey = `${body.ref.kind}:${body.ref.slug}:${body.event}`.slice(0, 200);
  const volumeLimited = await limit([
    { key: `book:page:${pageKey}`, max: PAGE_DAILY_MAX, windowSeconds: 86_400 },
    { key: "book:global", max: GLOBAL_DAILY_MAX, windowSeconds: 86_400 },
  ]);
  if (volumeLimited) return volumeLimited;

  try {
    const result = await createBooking(
      {
        owner: body.ref,
        eventSlug: body.event,
        language: body.lang,
        start: body.start,
        durationMin: body.duration,
        name: body.name,
        email: body.email,
        phone: body.phone || null,
        timezone: body.timezone,
        answers: body.answers,
        idempotencyKey: body.idempotencyKey ?? null,
      },
      bookingOptions(),
    );
    return json({ token: result.token, booking: result.view }, result.replayed ? 200 : 201);
  } catch (err) {
    return mapBookingError(err, "book");
  }
}
