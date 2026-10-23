import "server-only";
import { service, type Db, type Sql } from "@/server/db/client";
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
 * Records an error in app.error_log. Repeats of an unresolved error with the same fingerprint
 * increment its occurrence count instead of adding a row.
 *
 * Never throws and never rejects: a failure to log is reported on stderr without details and
 * the caller continues. Writes with the service connection outside the caller's transaction,
 * so the entry survives a rollback. Next.js redirect and not-found signals are ignored.
 */
export async function logError(err: unknown, opts: LogErrorOptions): Promise<void> {
  try {
    if (isFrameworkSignal(err)) return;
    const row = prepareError(err, opts);
    const db: Db = opts.db ?? service();
    await db`
      insert into app.error_log (fingerprint, source, route, method, error_name, message, stack, digest, context)
      values (${row.fingerprint}, ${row.source}, ${row.route}, ${row.method}, ${row.errorName}, ${row.message},
              ${row.stack}, ${row.digest}, ${(db as Sql).json(row.context as never)})
      on conflict (fingerprint) where resolved_at is null do update set
        occurrences = least(app.error_log.occurrences::bigint + 1, 2147483647)::int,
        last_seen_at = greatest(app.error_log.last_seen_at, now()),
        message = excluded.message,
        stack = coalesce(excluded.stack, app.error_log.stack),
        digest = coalesce(excluded.digest, app.error_log.digest),
        method = coalesce(excluded.method, app.error_log.method),
        context = excluded.context
    `;
  } catch (failure) {
    try {
      const code = failure && typeof failure === "object" && "code" in failure ? String((failure as { code: unknown }).code) : "unknown";
      console.error(`[error-log] could not record an error (source=${opts?.source ?? "unknown"}, code=${code})`);
    } catch {
      // Nothing else to do.
    }
  }
}
