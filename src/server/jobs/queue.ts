import "server-only";
import type { Db } from "@/server/db/client";
import type { EnqueueInput } from "@/server/jobs/types";

/**
 * Adds a job to the outbox. Call it inside the transaction that makes the change so the
 * job exists only if the change commits. Duplicate (kind, idempotencyKey) pairs are ignored.
 * Returns the job id, or null when an identical job already exists.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<string | null> {
  const rows = await db<{ id: string }[]>`
    insert into app.jobs (kind, payload, idempotency_key, run_at, max_attempts, booking_id, team_id)
    values (${input.kind}, ${db.json(input.payload as never)}, ${input.idempotencyKey ?? null},
            ${input.runAt ?? new Date()}, ${input.maxAttempts ?? 8}, ${input.bookingId ?? null}, ${input.teamId ?? null})
    on conflict (kind, idempotency_key) do nothing
    returning id
  `;
  return rows[0]?.id ?? null;
}

/** Exponential backoff with full jitter: 30s, 60s, 120s ... capped at 1 hour. */
export function backoffSeconds(attempt: number, random = Math.random): number {
  const base = Math.min(30 * 2 ** Math.max(0, attempt - 1), 3600);
  return Math.round(base / 2 + random() * (base / 2));
}
