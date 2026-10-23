import { NextResponse } from "next/server";
import { BodyTooLargeError, jsonError, readBodyLimited } from "@/server/sync/http";
import { handleInboundSms } from "@/server/sms/inbound";

export const dynamic = "force-dynamic";

/**
 * SendBlue receive webhook. Records STOP / START replies in the SMS opt-out list.
 * Authenticated with the sb-signing-secret header (SENDBLUE_WEBHOOK_SECRET).
 */
export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readBodyLimited(req, 64 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("payload_too_large", 413);
    throw err;
  }
  const result = await handleInboundSms(req.headers, raw);
  return NextResponse.json(result.body, { status: result.status });
}
