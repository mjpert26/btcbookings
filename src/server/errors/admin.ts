import "server-only";
import type { Db, Tx } from "@/server/db/client";
import { changedFields, writeAudit } from "@/server/audit";
import { ERROR_SOURCES, type ErrorSource } from "@/server/errors/sanitize";

export const ERROR_STATUSES = ["unresolved", "resolved", "all"] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

export type ErrorLogRow = {
  id: string;
  source: ErrorSource;
  route: string | null;
  method: string | null;
  error_name: string;
  message: string;
  stack: string | null;
  digest: string | null;
  context: Record<string, unknown>;
  occurrences: number;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  resolved_by_name: string | null;
};

export function isErrorSource(value: unknown): value is ErrorSource {
  return typeof value === "string" && (ERROR_SOURCES as readonly string[]).includes(value);
}

/**
 * Lists error log entries, most recently seen first. Run inside withUser() for an admin;
 * RLS returns nothing to anyone else.
 */
export async function listErrors(
  tx: Tx,
  f: { source?: ErrorSource; status: ErrorStatus; limit: number; offset: number },
): Promise<ErrorLogRow[]> {
  return tx<ErrorLogRow[]>`
    select e.id, e.source, e.route, e.method, e.error_name, e.message, e.stack, e.digest, e.context,
           e.occurrences, e.first_seen_at, e.last_seen_at, e.resolved_at, u.name as resolved_by_name
    from app.error_log e
    left join app.users u on u.id = e.resolved_by
    where true
      ${f.source ? tx`and e.source = ${f.source}` : tx``}
      ${f.status === "unresolved" ? tx`and e.resolved_at is null` : f.status === "resolved" ? tx`and e.resolved_at is not null` : tx``}
    order by e.last_seen_at desc, e.id
    limit ${f.limit} offset ${f.offset}
  `;
}

export async function countUnresolvedErrors(tx: Tx): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app.error_log where resolved_at is null`;
  return n;
}

export type ResolveResult = { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Marks an entry resolved or reopens it, with an audit entry in the same transaction.
 * Run inside withUser() for the acting admin. Reopening is refused while a newer unresolved
 * entry with the same fingerprint exists, because only one open entry per fingerprint is kept.
 */
export async function setErrorResolved(tx: Tx, actorUserId: string, id: string, resolved: boolean): Promise<ResolveResult> {
  const [row] = await tx<{ id: string; fingerprint: string; resolved_at: Date | null; resolved_by: string | null }[]>`
    select id, fingerprint, resolved_at, resolved_by from app.error_log where id = ${id} for update
  `;
  if (!row) return { ok: false, error: "Error entry not found." };
  if (resolved === (row.resolved_at !== null)) return { ok: true, changed: false };

  if (!resolved) {
    const [open] = await tx<{ id: string }[]>`
      select id from app.error_log where fingerprint = ${row.fingerprint} and resolved_at is null and id <> ${id}
    `;
    if (open) return { ok: false, error: "This error has happened again since it was resolved. The newer entry is already open." };
  }

  const [updated] = await tx<{ resolved_at: Date | null; resolved_by: string | null }[]>`
    update app.error_log
    set resolved_at = ${resolved ? tx`now()` : null}, resolved_by = ${resolved ? actorUserId : null}
    where id = ${id}
    returning resolved_at, resolved_by
  `;
  if (!updated) return { ok: false, error: "Error entry not found." };

  const diff = changedFields(
    { resolvedAt: row.resolved_at?.toISOString() ?? null, resolvedBy: row.resolved_by },
    { resolvedAt: updated.resolved_at?.toISOString() ?? null, resolvedBy: updated.resolved_by },
  );
  await writeAudit(tx, {
    actorUserId,
    action: resolved ? "error.resolve" : "error.reopen",
    entityType: "error_log",
    entityId: id,
    before: diff?.before,
    after: diff?.after,
  });
  return { ok: true, changed: true };
}

/**
 * Retention for the daily maintenance cron: resolved entries are kept for 90 days after they
 * were resolved, and no entry is kept more than 180 days after it was last seen.
 */
export async function purgeErrorLog(db: Db): Promise<{ deleted: number }> {
  const rows = await db`
    delete from app.error_log
    where (resolved_at is not null and resolved_at < now() - interval '90 days')
       or last_seen_at < now() - interval '180 days'
  `;
  return { deleted: rows.count };
}
