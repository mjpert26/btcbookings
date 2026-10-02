import "server-only";
import { service } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import type { EnqueueInput } from "@/server/jobs/types";

/**
 * Enqueues jobs for a change that a withUser transaction has already authorized and
 * committed. app_user has no insert grant on app.jobs (the outbox is trusted code only),
 * so internal UI actions enqueue through the service connection right after the RLS
 * transaction succeeds. Callers pass idempotency keys derived from the committed change
 * so a retried action never enqueues duplicates.
 */
export async function enqueueAfterCommit(jobs: EnqueueInput[]): Promise<void> {
  if (!jobs.length) return;
  await service().begin(async (tx) => {
    for (const job of jobs) await enqueue(tx, job);
  });
}
