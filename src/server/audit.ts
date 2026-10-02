import "server-only";
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

/**
 * Appends to the audit log. Call inside the same transaction as the change so the
 * entry and the change commit together. Never pass secrets in before/after.
 */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db`
    insert into app.audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip_hash)
    values (${e.actorUserId}, ${e.action}, ${e.entityType}, ${e.entityId ?? null},
            ${e.before === undefined ? null : db.json(e.before as never)},
            ${e.after === undefined ? null : db.json(e.after as never)},
            ${e.ipHash ?? null})
  `;
}
