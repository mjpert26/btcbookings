import { BodyTooLargeError, jsonError, readBodyLimited } from "@/server/sync/http";
import { handleTwilioInbound } from "@/server/sms/twilio-inbound";

export const dynamic = "force-dynamic";

/**
 * Twilio incoming-message webhook. Records STOP / START replies in the SMS opt-out list.
 * Authenticated with the X-Twilio-Signature header, checked against TWILIO_AUTH_TOKEN
 * (Admin > Settings, else Vercel) by handleTwilioInbound.
 */
export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readBodyLimited(req, 64 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("payload_too_large", 413);
    throw err;
  }
  const result = await handleTwilioInbound(req.url, req.headers, raw);
  return new Response(result.body, { status: result.status, headers: { "content-type": result.contentType } });
}
