import "server-only";
import { after } from "next/server";
import { service, type Db, type Sql, type Tx } from "@/server/db/client";
import { isFrameworkSignal, prepareError, type ErrorSource } from "@/server/errors/sanitize";

export { ERROR_SOURCES, isFrameworkSignal, type ErrorSource } from "@/server/errors/sanitize";

export type LogErrorOptions = {
  source: ErrorSource;
  /** Route pattern or path. Query strings and identifier-like segments are removed. */
  route?: string | null;
  method?: string | null;
  /** Small, non-personal details (ids, kinds, counts). Strings are redacted; secret-named keys are dropped. */
  context?: Record<string, unknown>;
  /** Overrides the digest read from the error (Next.js render errors carry one). */
  digest?: string | null;
  /** Connection to write with. Defaults to the service connection. */
  db?: Db;
};

/**
 * Bounds on one error log write, so that a slow or locked database (often the cause of the
 * error being logged) cannot hold up the caller for long.
 */
export const LOG_WRITE_LIMITS = { lockTimeoutMs: 2000, statementTimeoutMs: 3000, overallMs: 5000 } as const;

class LogWriteTimeout extends Error {
  code = "log_write_timeout";
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LogWriteTimeout()), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Records an error in app.error_log. Repeats of an unresolved error with the same fingerprint
 * increment its occurrence count instead of adding a row.
 *
 * Never throws and never rejects: a failure to log is reported on stderr without details and
 * the caller continues. Writes with the service connection outside the caller's transaction,
 * so the entry survives a rollback. Next.js redirect and not-found signals are ignored.
 *
 * On a connection (not a transaction) the insert runs in its own short transaction with a lock
 * timeout and a statement timeout. The whole call gives up after LOG_WRITE_LIMITS.overallMs,
 * which also covers waiting for a free pooled connection.
 */
export async function logError(err: unknown, opts: LogErrorOptions): Promise<void> {
  try {
    if (isFrameworkSignal(err)) return;
    const row = prepareError(err, opts);
    const db: Db = opts.db ?? service();
    const insert = (q: Db) => q`
      insert into app.error_log (fingerprint, source, route, method, error_name, message, stack, digest, context)
      values (${row.fingerprint}, ${row.source}, ${row.route}, ${row.method}, ${row.errorName}, ${row.message},
              ${row.stack}, ${row.digest}, ${(q as Sql).json(row.context as never)})
      on conflict (fingerprint) where resolved_at is null do update set
        occurrences = least(app.error_log.occurrences::bigint + 1, 2147483647)::int,
        last_seen_at = greatest(app.error_log.last_seen_at, now()),
        message = excluded.message,
        stack = coalesce(excluded.stack, app.error_log.stack),
        digest = coalesce(excluded.digest, app.error_log.digest),
        method = coalesce(excluded.method, app.error_log.method),
        context = excluded.context
    `;
    // A transaction handle has no begin(); SET LOCAL there would change the caller's transaction.
    const write =
      typeof (db as Sql).begin === "function"
        ? (db as Sql).begin(async (tx: Tx) => {
            await tx.unsafe(`set local lock_timeout = ${LOG_WRITE_LIMITS.lockTimeoutMs}`);
            await tx.unsafe(`set local statement_timeout = ${LOG_WRITE_LIMITS.statementTimeoutMs}`);
            await insert(tx);
          })
        : insert(db);
    await withDeadline(Promise.resolve(write), LOG_WRITE_LIMITS.overallMs);
  } catch (failure) {
    try {
      const code = failure && typeof failure === "object" && "code" in failure ? String((failure as { code: unknown }).code) : "unknown";
      console.error(`[error-log] could not record an error (source=${opts?.source ?? "unknown"}, code=${code})`);
    } catch {
      // Nothing else to do.
    }
  }
}

/**
 * Records an error after the response has been sent, so that a slow error log write never
 * delays an error response. Outside a Next.js request (tests, scripts, the job worker),
 * `after` is unavailable and the entry is written before returning instead. Never rejects.
 */
export async function logErrorAfterResponse(err: unknown, opts: LogErrorOptions): Promise<void> {
  try {
    after(() => logError(err, opts));
  } catch {
    await logError(err, opts);
  }
}
