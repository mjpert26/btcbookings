import { NextResponse } from "next/server";
import { z } from "zod";
import { applyPushChange } from "@/server/sync/apply";
import {
  BodyTooLargeError,
  checkPushBearer,
  checkSyncHmac,
  claimNonce,
  hasHmacHeaders,
  isFreshIsoTimestamp,
  jsonError,
  NONCE_SOURCE_PUSH,
  parseJson,
  readBodyLimited,
} from "@/server/sync/http";

export const dynamic = "force-dynamic";

const pushSchema = z.object({
  eventId: z.string().min(8).max(200),
  timestamp: z.string().min(1).max(64),
  action: z.enum(["added", "removed"]),
  queueId: z.string().regex(/^00G[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/),
  sfUserId: z
    .string()
    .regex(/^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/)
    .nullish(),
  email: z.string().trim().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/),
});

/**
 * Single membership change pushed from Salesforce (optional; the poller is the source of truth).
 *
 * Authentication, either:
 *   - HMAC headers (X-BTC-Timestamp, X-BTC-Signature) with SF_SYNC_SIGNING_SECRET, for Apex/n8n; or
 *   - Authorization: Bearer <SF_QUEUE_PUSH_BEARER>, for a Flow HTTP Callout via External Credential.
 * Both require a body `timestamp` within 5 minutes and a unique `eventId` (replay protection).
 */
export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readBodyLimited(req, 64 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("payload_too_large", 413);
    throw err;
  }
  const auth = hasHmacHeaders(req) ? checkSyncHmac(req, raw) : checkPushBearer(req);
  if (!auth.ok) return auth.response;

  const parsed = pushSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    return jsonError("invalid_body", 400, {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const body = parsed.data;
  if (!isFreshIsoTimestamp(body.timestamp)) return jsonError("stale", 401);
  if (!(await claimNonce(NONCE_SOURCE_PUSH, body.eventId))) return jsonError("replayed", 409);

  const result = await applyPushChange(body);
  if (!result.linked) {
    // Pushes for queues no team links to are expected (the Flow manages every queue).
    return NextResponse.json({ ok: true, ignored: true, reason: "queue_not_linked", teams: [] });
  }
  const failed = result.teams.some((t) => t.status === "error");
  return NextResponse.json({ ok: !failed, teams: result.teams }, { status: failed ? 500 : 200 });
}
