import { NextResponse } from "next/server";
import { z } from "zod";
import { applySnapshot } from "@/server/sync/apply";
import {
  BodyTooLargeError,
  checkSyncHmac,
  claimNonce,
  jsonError,
  NONCE_SOURCE_SNAPSHOT,
  parseJson,
  readBodyLimited,
} from "@/server/sync/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const sfId = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$`);

const snapshotSchema = z.object({
  snapshotId: z.string().min(1).max(200),
  takenAt: z.iso.datetime({ offset: true }),
  queues: z
    .array(
      z.object({
        queueId: z.string().regex(sfId("00G")),
        members: z
          .array(
            z.object({
              sfUserId: z.string().regex(sfId("005")),
              email: z.string().trim().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/),
              isActive: z.boolean(),
            }),
          )
          .max(10_000),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Full membership snapshot from the n8n poller. HMAC-signed (SF_SYNC_SIGNING_SECRET); the
 * signed snapshotId must be unique (replay protection).
 */
export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readBodyLimited(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("payload_too_large", 413);
    throw err;
  }
  const auth = checkSyncHmac(req, raw);
  if (!auth.ok) return auth.response;

  const parsed = snapshotSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    return jsonError("invalid_body", 400, {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  // Replay protection uses the snapshotId, which is inside the signed body. The unsigned
  // X-BTC-Nonce header is no longer trusted for this (it could be changed on a replay).
  if (!(await claimNonce(NONCE_SOURCE_SNAPSHOT, parsed.data.snapshotId))) return jsonError("replayed", 409);

  const result = await applySnapshot(parsed.data);
  if (result.teams.length === 0) {
    return jsonError("unlinked_queues", 422, { rejectedQueueIds: result.rejectedQueueIds });
  }
  const failed = result.teams.some((t) => t.status === "error");
  return NextResponse.json(
    { ok: !failed, snapshotId: parsed.data.snapshotId, teams: result.teams, rejectedQueueIds: result.rejectedQueueIds },
    { status: failed ? 500 : 200 },
  );
}
