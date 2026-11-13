import "server-only";
import { z } from "zod";
import { service, type Db } from "@/server/db/client";
import { sha256Hex, safeEqual } from "@/server/crypto/random";
import { integrationSettings } from "@/server/settings/integrations";
import { clearOptOut, parseOptKeyword, recordOptOut } from "@/server/sms/opt-out";
import { normalizeE164 } from "@/server/sms/phone";

/**
 * SendBlue receive webhook (POST /api/sms/inbound).
 *
 * Authentication: SendBlue sends the webhook's configured signing secret in the
 * sb-signing-secret header. It is compared in constant time with the SENDBLUE_WEBHOOK_SECRET
 * setting (Admin > Settings, else Vercel).
 *
 * Only opt-out keywords are acted on: STOP (and equivalents) adds the sender to
 * app.sms_opt_outs, START removes it. A payload with opted_out = true is also recorded.
 * Message text and phone numbers are never logged.
 *
 * SendBlue can deliver replies for every line on the account. When SENDBLUE_FROM_NUMBER is
 * set, a reply that arrived on another line (sendblue_number, else to_number) is ignored: it
 * is not about the scheduler's texts. A reply without a receiving line is still acted on.
 */
export const SIGNING_SECRET_HEADER = "sb-signing-secret";

const inboundSchema = z.object({
  number: z.string().max(40).nullish(),
  from_number: z.string().max(40).nullish(),
  content: z.string().max(20_000).nullish(),
  is_outbound: z.boolean().nullish(),
  opted_out: z.boolean().nullish(),
  message_handle: z.string().max(200).nullish(),
  sendblue_number: z.string().max(40).nullish(),
  to_number: z.string().max(40).nullish(),
});

/** Digits with a leading plus, for comparing two spellings of the same line number. */
export function lineKey(value: string | null | undefined): string | null {
  const key = value?.replace(/[^\d+]/g, "") ?? "";
  return key.length > 1 ? key : null;
}

export type InboundResult = { status: number; body: Record<string, unknown> };

export function checkSigningSecret(headerValue: string | null, secret: string | undefined): "ok" | "not_configured" | "unauthorized" {
  if (!secret) return "not_configured";
  if (!headerValue) return "unauthorized";
  // Hash both sides so the comparison is constant time regardless of length.
  return safeEqual(sha256Hex(headerValue), sha256Hex(secret)) ? "ok" : "unauthorized";
}

export async function handleInboundSms(
  headers: Pick<Headers, "get">,
  raw: string,
  opts: { db?: Db; secret?: string; lineNumber?: string | null } = {},
): Promise<InboundResult> {
  const config = opts.secret === undefined || opts.lineNumber === undefined ? await integrationSettings() : null;
  const secret = opts.secret ?? config?.SENDBLUE_WEBHOOK_SECRET;
  const auth = checkSigningSecret(headers.get(SIGNING_SECRET_HEADER), secret);
  if (auth === "not_configured") return { status: 503, body: { error: "not_configured" } };
  if (auth === "unauthorized") return { status: 401, body: { error: "unauthorized" } };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const parsed = inboundSchema.safeParse(json);
  if (!parsed.success) return { status: 400, body: { error: "invalid_body" } };
  const msg = parsed.data;
  if (msg.is_outbound) return { status: 200, body: { ok: true, action: "ignored_outbound" } };

  const ourLine = lineKey(opts.lineNumber !== undefined ? opts.lineNumber : config?.SENDBLUE_FROM_NUMBER);
  const receivedOn = lineKey(msg.sendblue_number ?? msg.to_number);
  if (ourLine && receivedOn && receivedOn !== ourLine) return { status: 200, body: { ok: true, action: "ignored_other_line" } };

  // For received messages, `number` is the end user; from_number is the sender (the same person).
  const action = await applyReply(opts.db ?? service(), msg.number ?? msg.from_number ?? null, msg.content, msg.opted_out ? "stop" : null);
  return { status: 200, body: { ok: true, action } };
}

export type ReplyAction = "opted_out" | "opted_in" | "ignored" | "ignored_no_number";

/**
 * Applies one inbound reply to the opt-out list, for every provider. A stop keyword in the
 * text adds the sender, a start keyword removes it. Without a keyword, `providerFlag` (the
 * provider's own opt-out report) decides. Never logs the text or the number.
 */
export async function applyReply(db: Db, sender: string | null, content: string | null | undefined, providerFlag: "stop" | "start" | null): Promise<ReplyAction> {
  const phone = normalizeE164(sender);
  if (!phone) return "ignored_no_number";
  const keyword = parseOptKeyword(content);
  if (keyword?.action === "stop") {
    await recordOptOut(db, phone, keyword.keyword);
    return "opted_out";
  }
  if (keyword?.action === "start") {
    await clearOptOut(db, phone);
    return "opted_in";
  }
  if (providerFlag === "stop") {
    await recordOptOut(db, phone, "PROVIDER");
    return "opted_out";
  }
  if (providerFlag === "start") {
    await clearOptOut(db, phone);
    return "opted_in";
  }
  return "ignored";
}
