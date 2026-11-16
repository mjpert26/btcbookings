import type { NextRequest } from "next/server";
import { z } from "zod";
import { LOCALES } from "@/i18n/locales";
import { clientIp, hashIp } from "@/server/http/ip";
import { rateLimit } from "@/server/http/rate-limit";
import { verifyTurnstile } from "@/server/http/turnstile";
import { emailKey, json, jsonError, limit, readJson, sameOrigin } from "@/server/booking/http";
import { routeVisitor } from "@/server/home/route";

export const dynamic = "force-dynamic";

/** Lookups per hashed IP, and per email, in a ten-minute window. */
const IP_MAX = 5;
const EMAIL_MAX = 3;
const WINDOW_SECONDS = 600;
/** Salesforce lookups per day across all visitors. Above it, visitors go to the new-business page. */
const GLOBAL_DAILY_MAX = 1000;

const bodySchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase()),
  turnstileToken: z.string().max(2048).nullish(),
  lang: z.enum(LOCALES).default("en"),
});

/**
 * POST /api/public/lookup. The home page's "Already applied or already a customer?" form:
 * looks the email up in Salesforce (through n8n) and answers with the booking page to open.
 *
 * The answer is always { next: string | null } with status 200, whatever the outcome: it never
 * says whether the email was found, and never contains ids, emails, names, the route or the
 * renewal book. `next` is a relative path. Failures of the lookup route the visitor as new.
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return jsonError(403, "forbidden");
  const ipLimited = await limit([{ key: `lookup:ip:${hashIp(req.headers)}`, max: IP_MAX, windowSeconds: WINDOW_SECONDS }]);
  if (ipLimited) return ipLimited;

  const parsed = bodySchema.safeParse(await readJson(req, 4096));
  if (!parsed.success) return jsonError(400, "invalid");
  const body = parsed.data;

  const emailLimited = await limit([{ key: `lookup:email:${emailKey(body.email)}`, max: EMAIL_MAX, windowSeconds: WINDOW_SECONDS }]);
  if (emailLimited) return emailLimited;

  const turnstile = await verifyTurnstile(body.turnstileToken, { action: "lookup", remoteIp: clientIp(req.headers) });
  if (!turnstile.ok) return jsonError(400, "verification_failed");

  // At the daily cap the visitor still gets a page: the new-business pool, without a lookup.
  const daily = await rateLimit("lookup:global", GLOBAL_DAILY_MAX, 86_400);

  try {
    const result = await routeVisitor(body.email, { locale: body.lang, skipLookup: !daily.allowed });
    return json({ next: result.next });
  } catch (err) {
    console.error(`[lookup] unexpected error: ${(err as Error)?.name ?? "Error"}`);
    return jsonError(500, "error");
  }
}
