import "server-only";
import { service, type Sql } from "@/server/db/client";
import { backoffSeconds } from "@/server/jobs/queue";
import {
  PermanentJobError,
  RetryAfterError,
  type AttemptLog,
  type JobHandler,
  type JobRow,
} from "@/server/jobs/types";

const LOCK_SECONDS = 300;

export type WorkerReport = { claimed: number; succeeded: number; retried: number; dead: number; unknownKind: number };

/**
 * Claims ready jobs with FOR UPDATE SKIP LOCKED so overlapping cron invocations never run
 * the same job twice, then executes them with the registered handlers.
 */
export async function runJobs(
  handlers: Record<string, JobHandler>,
  opts: { limit?: number; deadlineMs?: number; kinds?: string[]; sql?: Sql } = {},
): Promise<WorkerReport> {
  const sql = opts.sql ?? service();
  const deadline = Date.now() + (opts.deadlineMs ?? 50_000);
  const report: WorkerReport = { claimed: 0, succeeded: 0, retried: 0, dead: 0, unknownKind: 0 };
  const kinds = opts.kinds ?? Object.keys(handlers);

  while (Date.now() < deadline) {
    const batch = await sql<JobRow[]>`
      update app.jobs j set status = 'running', attempts = j.attempts + 1,
             locked_until = now() + make_interval(secs => ${LOCK_SECONDS})
      where j.id in (
        select id from app.jobs
        where kind = any(${kinds})
          and ((status in ('pending', 'failed') and run_at <= now())
               or (status = 'running' and locked_until < now()))
        order by run_at
        limit ${opts.limit ?? 10}
        for update skip locked
      )
      returning j.id, j.kind, j.payload, j.attempts, j.max_attempts, j.idempotency_key, j.booking_id, j.team_id
    `;
    if (batch.length === 0) break;
    report.claimed += batch.length;
    for (const job of batch) {
      const outcome = await executeJob(sql, handlers, job);
      report[outcome]++;
    }
  }
  return report;
}

export async function executeJob(
  sql: Sql,
  handlers: Record<string, JobHandler>,
  job: JobRow,
): Promise<"succeeded" | "retried" | "dead" | "unknownKind"> {
  const handler = handlers[job.kind];
  const started = Date.now();
  let log: AttemptLog = {};
  const ctx = { log: (e: AttemptLog) => void (log = { ...log, ...e }) };

  const recordAttempt = (error: string | null) => sql`
    insert into app.job_attempts (job_id, attempt_no, request_summary, response_code, error, duration_ms)
    values (${job.id}, ${job.attempts}, ${log.request ? sql.json(log.request as never) : null},
            ${log.responseCode ?? null}, ${error}, ${Date.now() - started})
  `;

  if (!handler) {
    await sql`update app.jobs set status = 'dead', last_error = ${"No handler for kind " + job.kind}, locked_until = null where id = ${job.id}`;
    return "unknownKind";
  }

  try {
    const out = await handler(job, ctx);
    await recordAttempt(null);
    await sql`
      update app.jobs set status = 'succeeded', locked_until = null, last_error = null,
             result = ${out && out.result ? sql.json(out.result as never) : null}
      where id = ${job.id}
    `;
    return "succeeded";
  } catch (err) {
    const message = (err as Error).message?.slice(0, 1000) ?? String(err);
    await recordAttempt(message);
    const permanent = err instanceof PermanentJobError;
    if (permanent || job.attempts >= job.max_attempts) {
      const result = permanent && (err as PermanentJobError).result ? sql.json((err as PermanentJobError).result as never) : null;
      await sql`
        update app.jobs set status = 'dead', locked_until = null, last_error = ${message},
               result = coalesce(${result}, result)
        where id = ${job.id}
      `;
      return "dead";
    }
    const delay = err instanceof RetryAfterError ? err.retryAfterSeconds : backoffSeconds(job.attempts);
    await sql`
      update app.jobs set status = 'failed', locked_until = null, last_error = ${message},
             run_at = now() + make_interval(secs => ${delay})
      where id = ${job.id}
    `;
    return "retried";
  }
}
