import { computeSignature } from "@/server/crypto/hmac";
import type { Sql } from "@/server/db/client";

export const SYNC_SECRET = process.env.SF_SYNC_SIGNING_SECRET!;
export const PUSH_BEARER = process.env.SF_QUEUE_PUSH_BEARER!;

let n = 0;
/** Valid 18-character Salesforce ids for tests (checksum suffix is not validated for users). */
export function sfUserId(): string {
  n++;
  return `005Vy0000${String(n).padStart(6, "0")}AAA`;
}

export function signedHeaders(rawBody: string, opts: { nonce?: string | null; ts?: number; secret?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-btc-timestamp": ts,
    "x-btc-signature": computeSignature(opts.secret ?? SYNC_SECRET, ts, rawBody),
  };
  if (opts.nonce !== null) headers["x-btc-nonce"] = opts.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
  return headers;
}

export function signedPost(url: string, body: unknown, opts: Parameters<typeof signedHeaders>[1] = {}): Request {
  const raw = JSON.stringify(body);
  return new Request(url, { method: "POST", headers: signedHeaders(raw, opts), body: raw });
}

export async function makeTeam(
  sql: Sql,
  over: Partial<{ slug: string; membershipSource: string; removalPolicy: string; thresholdPct: number }> = {},
): Promise<string> {
  const slug = over.slug ?? `team-${Math.random().toString(36).slice(2, 8)}`;
  const [t] = await sql<{ id: string }[]>`
    insert into app.teams (name, slug, membership_source, removal_policy, mass_removal_threshold_pct)
    values (${slug}, ${slug}, ${over.membershipSource ?? "salesforce_queue"}, ${over.removalPolicy ?? "keep_bookings"},
            ${over.thresholdPct ?? 50})
    returning id
  `;
  return t.id;
}

export async function linkTestQueue(sql: Sql, teamId: string, queueId: string): Promise<void> {
  await sql`insert into app.team_sf_queues (team_id, queue_id) values (${teamId}, ${queueId})`;
}
