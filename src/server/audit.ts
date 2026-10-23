import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "@/server/db/client";

export type AuditEntry = {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
  via?: AuditVia | null;
};

/** The channel a change came through. */
export type AuditVia = "web" | "api" | "mcp" | "sync" | "system";

type AuditContext = { ipHash: string | null; via?: AuditVia };

const context = new AsyncLocalStorage<AuditContext>();

/**
 * Runs `fn` with request metadata that every writeAudit() call inside it records, so
 * back-end modules do not need an ip hash parameter. Server actions wrap their calls into
 * the admin modules with this.
 */
export function withAuditContext<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return context.run(ctx, fn);
}

/**
 * Appends to the audit log. Call inside the same transaction as the change so the
 * entry and the change commit together. Never pass secrets in before/after.
 */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  const store = context.getStore();
  const ipHash = e.ipHash ?? store?.ipHash ?? null;
  const via = e.via ?? store?.via ?? (e.actorUserId ? "web" : "system");
  await db`
    insert into app.audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip_hash, via)
    values (${e.actorUserId}, ${e.action}, ${e.entityType}, ${e.entityId ?? null},
            ${e.before === undefined ? null : db.json(e.before as never)},
            ${e.after === undefined ? null : db.json(e.after as never)},
            ${ipHash}, ${via})
  `;
}

/**
 * The fields that differ between two snapshots of a record, for audit entries that show
 * exactly what changed. Values are compared as JSON.
 */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
