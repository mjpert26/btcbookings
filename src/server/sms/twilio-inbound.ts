import "server-only";
import { service, type Db } from "@/server/db/client";
import { env } from "@/server/env";
import { integrationSettings } from "@/server/settings/integrations";
import { applyReply, lineKey } from "@/server/sms/inbound";
import { validTwilioSignature } from "@/server/sms/twilio";

/**
 * Twilio incoming-message webhook (POST /api/sms/twilio), set as "A message comes in" on the
 * sending number in the Twilio Console.
 *
 * Authentication: the X-Twilio-Signature header must match the request, signed with
 * TWILIO_AUTH_TOKEN (Admin > Settings, else Vercel). Without the token the route answers 503.
 *
 * Only opt-out replies are acted on, through the same rules as SendBlue replies: a stop
 * keyword adds the sender (From) to app.sms_opt_outs and a start keyword removes it. Twilio's
 * Advanced Opt-Out field OptOutType (STOP, START) is honoured as well. Replies to another
 * number than TWILIO_FROM_NUMBER (the To field) are ignored. The answer is an empty TwiML
 * response, so the app never replies; Twilio itself answers STOP and HELP.
 */

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export type TwilioInboundResult = { status: number; body: string; contentType: "text/xml" | "application/json" };

const json = (status: number, error: string): TwilioInboundResult => ({ status, body: JSON.stringify({ error }), contentType: "application/json" });

/**
 * URLs Twilio may have signed: the URL as received and the same path on APP_BASE_URL, each
 * also with the default port written out (Twilio's helper libraries accept both forms).
 */
export function signedUrlCandidates(requestUrl: string): string[] {
  const received = new URL(requestUrl);
  const origins = [received.origin];
  try {
    origins.push(new URL(env().APP_BASE_URL).origin);
  } catch {
    // APP_BASE_URL is validated by env(); without it, only the received URL is checked.
  }
  const candidates: string[] = [];
  for (const origin of new Set(origins)) {
    const url = new URL(`${origin}${received.pathname}${received.search}`);
    candidates.push(url.toString());
    const defaultPort = url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : null;
    if (!url.port && defaultPort) candidates.push(`${url.protocol}//${url.host}:${defaultPort}${url.pathname}${url.search}`);
  }
  return candidates;
}

export async function handleTwilioInbound(
  requestUrl: string,
  headers: Pick<Headers, "get">,
  raw: string,
  opts: { db?: Db; authToken?: string; fromNumber?: string | null } = {},
): Promise<TwilioInboundResult> {
  const config = opts.authToken === undefined || opts.fromNumber === undefined ? await integrationSettings() : null;
  const token = opts.authToken ?? config?.TWILIO_AUTH_TOKEN;
  if (!token) return json(503, "not_configured");

  const params = new URLSearchParams(raw);
  if (!validTwilioSignature(token, headers.get(TWILIO_SIGNATURE_HEADER), signedUrlCandidates(requestUrl), params)) {
    return json(401, "unauthorized");
  }

  const ourNumber = lineKey(opts.fromNumber !== undefined ? opts.fromNumber : config?.TWILIO_FROM_NUMBER);
  const receivedOn = lineKey(params.get("To"));
  if (!(ourNumber && receivedOn && receivedOn !== ourNumber)) {
    const optOutType = (params.get("OptOutType") ?? "").toUpperCase();
    const flag = optOutType === "STOP" ? "stop" : optOutType === "START" ? "start" : null;
    await applyReply(opts.db ?? service(), params.get("From"), params.get("Body"), flag);
  }
  return { status: 200, body: EMPTY_TWIML, contentType: "text/xml" };
}
