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
};

type AuditContext = { ipHash: string | null };

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
  const ipHash = e.ipHash ?? context.getStore()?.ipHash ?? null;
  await db`
    insert into app.audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip_hash)
    values (${e.actorUserId}, ${e.action}, ${e.entityType}, ${e.entityId ?? null},
            ${e.before === undefined ? null : db.json(e.before as never)},
            ${e.after === undefined ? null : db.json(e.after as never)},
            ${ipHash})
  `;
}
