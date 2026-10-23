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

/**
 * The channel a change came through: the internal web app, the REST API, the MCP server,
 * Salesforce queue sync, background jobs and webhooks ("system"), or an invitee on the
 * public booking pages ("public").
 */
export type AuditVia = "web" | "api" | "mcp" | "sync" | "system" | "public";

export const AUDIT_VIAS: readonly AuditVia[] = ["web", "api", "mcp", "sync", "system", "public"];

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
  const before = e.before === undefined || e.before === null ? null : redactSecrets(e.before);
  const after = e.after === undefined || e.after === null ? null : redactSecrets(e.after);
  await db`
    insert into app.audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip_hash, via)
    values (${e.actorUserId}, ${e.action}, ${e.entityType}, ${e.entityId ?? null},
            ${before === null ? null : db.json(before as never)},
            ${after === null ? null : db.json(after as never)},
            ${ipHash}, ${via})
  `;
}

/**
 * Writes an entry with only the fields that changed between `before` and `after`, using
 * changedFields(). Nothing is written when nothing changed. Returns whether an entry was
 * written.
 */
export async function writeAuditDiff<T extends Record<string, unknown>>(
  db: Db,
  e: Omit<AuditEntry, "before" | "after"> & { before: T; after: Partial<T> },
): Promise<boolean> {
  const diff = changedFields(e.before, e.after);
  if (!diff) return false;
  await writeAudit(db, { ...e, before: diff.before, after: diff.after });
  return true;
}

/** Key names whose values are never stored in the audit log, at any depth. */
const SECRET_KEY = /(secret|password|passphrase|private_?key|access_?token|refresh_?token|manage_?token|token_?(hash|enc)|bearer|authorization|api_?key_?value|signing)/i;

/**
 * Keys that are data rather than field names: email addresses (team hosts are keyed by
 * member email) and anything with whitespace. These are never treated as secret names.
 */
const DATA_KEY = /[@\s]/;

/**
 * Replaces the values of secret-looking keys with "[redacted]". A safety net only: callers
 * must not pass secrets in the first place.
 *
 * Only scalar and array values are redacted. When a secret-looking key holds an object, the
 * object is searched instead, because some snapshots key maps by data (question keys,
 * member emails, dates) and a key such as "signing_authority" must not hide the settings
 * stored under it.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const isRecord = v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
    const redact = v !== null && v !== undefined && !isRecord && !DATA_KEY.test(k) && SECRET_KEY.test(k);
    out[k] = redact ? "[redacted]" : redactSecrets(v, depth + 1);
  }
  return out;
}

/**
 * A phone number reduced to its last four digits ("***-4567"), for audit entries. Full
 * numbers are never stored in the audit log.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***-${digits.slice(-4)}`;
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
