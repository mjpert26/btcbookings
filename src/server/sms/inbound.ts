import "server-only";
import { z } from "zod";
import { service, type Db } from "@/server/db/client";
import { env } from "@/server/env";
import { sha256Hex, safeEqual } from "@/server/crypto/random";
import { clearOptOut, parseOptKeyword, recordOptOut } from "@/server/sms/opt-out";
import { normalizeE164 } from "@/server/sms/phone";

/**
 * SendBlue receive webhook (POST /api/sms/inbound).
 *
 * Authentication: SendBlue sends the webhook's configured signing secret in the
 * sb-signing-secret header. It is compared in constant time with SENDBLUE_WEBHOOK_SECRET.
 *
 * Only opt-out keywords are acted on: STOP (and equivalents) adds the sender to
 * app.sms_opt_outs, START removes it. A payload with opted_out = true is also recorded.
 * Message text and phone numbers are never logged.
 */
export const SIGNING_SECRET_HEADER = "sb-signing-secret";

const inboundSchema = z.object({
  number: z.string().max(40).nullish(),
  from_number: z.string().max(40).nullish(),
  content: z.string().max(20_000).nullish(),
  is_outbound: z.boolean().nullish(),
  opted_out: z.boolean().nullish(),
  message_handle: z.string().max(200).nullish(),
});

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
  opts: { db?: Db; secret?: string } = {},
): Promise<InboundResult> {
  const auth = checkSigningSecret(headers.get(SIGNING_SECRET_HEADER), opts.secret ?? env().SENDBLUE_WEBHOOK_SECRET);
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

  // For received messages, `number` is the end user; from_number is the sender (the same person).
  const phone = normalizeE164(msg.number ?? msg.from_number ?? null);
  if (!phone) return { status: 200, body: { ok: true, action: "ignored_no_number" } };

  const db = opts.db ?? service();
  const keyword = parseOptKeyword(msg.content);
  if (keyword?.action === "stop") {
    await recordOptOut(db, phone, keyword.keyword);
    return { status: 200, body: { ok: true, action: "opted_out" } };
  }
  if (keyword?.action === "start") {
    await clearOptOut(db, phone);
    return { status: 200, body: { ok: true, action: "opted_in" } };
  }
  if (msg.opted_out) {
    await recordOptOut(db, phone, "PROVIDER");
    return { status: 200, body: { ok: true, action: "opted_out" } };
  }
  return { status: 200, body: { ok: true, action: "ignored" } };
}
