import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { service, withUser } from "@/server/db/client";
import { changedFields, writeAudit } from "@/server/audit";
import { encryptSecret } from "@/server/crypto/aes";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import { enqueue } from "@/server/jobs/queue";
import type { SessionUser } from "@/server/auth/session";
import { checkWebhookUrl } from "@/server/webhooks/url";
import { testEventBody, WEBHOOK_EVENTS } from "@/server/webhooks/payload";

/** Admin management of webhook endpoints. Every change is audited; secrets are shown once. */

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

const MAX_ENDPOINTS = 50;

export const endpointInputSchema = z.object({
  url: z.string().trim().min(1, "Enter the endpoint URL.").max(2000),
  description: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => v || null),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Choose at least one event."),
  teamId: z
    .uuid()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
export type EndpointInput = z.input<typeof endpointInputSchema>;

export type EndpointRow = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  team_id: string | null;
  team_name: string | null;
  secret_prefix: string;
  enabled: boolean;
  created_at: Date;
  last_delivery_at: Date | null;
  last_status: number | null;
  consecutive_failures: number;
};

export type DeliveryRow = {
  id: string;
  endpoint_id: string;
  url: string;
  event: string;
  booking_id: string | null;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

function newSecret(): { secret: string; prefix: string } {
  const secret = `whsec_${randomToken(32)}`;
  return { secret, prefix: secret.slice(0, 12) };
}

/**
 * The form of an endpoint URL stored in the audit log. Many receivers (Zapier, n8n webhook
 * nodes, Slack incoming webhooks) treat the path as the credential, and managers can read
 * the audit log, so only the origin is kept, plus a short hash of the full URL that shows
 * when it changed. Migration 20261023126000 rewrote older entries to the same form.
 */
export function auditUrl(url: string): { url: string; urlHash: string } {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }
  return { url: `${origin}/…`, urlHash: sha256Hex(url).slice(0, 12) };
}

function validUrl(raw: string): string {
  const check = checkWebhookUrl(raw);
  if (!check.ok) throw new WebhookError(`The URL ${check.reason}.`);
  return check.url.toString();
}

async function assertAdmin(user: SessionUser): Promise<void> {
  const ok = await withUser(user.id, async (tx) => (await tx<{ ok: boolean }[]>`select app.is_admin() as ok`)[0]?.ok);
  if (!ok) throw new WebhookError("Admin access required.");
}

export async function listWebhooks(
  user: SessionUser,
): Promise<{ endpoints: EndpointRow[]; deliveries: DeliveryRow[]; teams: { id: string; name: string }[] }> {
  await assertAdmin(user);
  return withUser(user.id, async (tx) => {
    const endpoints = await tx<EndpointRow[]>`
      select e.id, e.url, e.description, e.events, e.team_id, t.name as team_name, e.secret_prefix, e.enabled, e.created_at,
             e.last_delivery_at, e.last_status, e.consecutive_failures
      from app.webhook_endpoints e left join app.teams t on t.id = e.team_id
      order by e.created_at
    `;
    const deliveries = await tx<DeliveryRow[]>`
      select d.id, d.endpoint_id, e.url, d.event, d.booking_id, d.status, d.attempts, d.response_status, d.error, d.created_at, d.delivered_at
      from app.webhook_deliveries d join app.webhook_endpoints e on e.id = d.endpoint_id
      order by d.created_at desc
      limit 50
    `;
    const teams = await tx<{ id: string; name: string }[]>`select id, name from app.teams order by name`;
    return { endpoints, deliveries, teams };
  });
}

/** Creates an endpoint and returns its signing secret, which is not shown again. */
export async function createWebhook(user: SessionUser, input: EndpointInput): Promise<{ id: string; secret: string }> {
  await assertAdmin(user);
  const v = endpointInputSchema.parse(input);
  const url = validUrl(v.url);
  const id = randomUUID();
  const { secret, prefix } = newSecret();
  await withUser(user.id, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app.webhook_endpoints`;
    if (n >= MAX_ENDPOINTS) throw new WebhookError(`At most ${MAX_ENDPOINTS} webhook endpoints.`);
    // No RETURNING: the id is generated here so it can be the secret's encryption context.
    await tx`
      insert into app.webhook_endpoints (id, url, description, events, team_id, secret_enc, secret_prefix, created_by)
      values (${id}, ${url}, ${v.description}, ${v.events}, ${v.teamId}, ${encryptSecret(secret, id)}, ${prefix}, ${user.id})
    `;
    await writeAudit(tx, {
      actorUserId: user.id,
      action: "webhook.create",
      entityType: "webhook_endpoint",
      entityId: id,
      after: { ...auditUrl(url), description: v.description, events: v.events, teamId: v.teamId, secretPrefix: prefix },
    });
  });
  return { id, secret };
}

export async function updateWebhook(user: SessionUser, id: string, input: EndpointInput & { enabled: boolean }): Promise<void> {
  await assertAdmin(user);
  const v = endpointInputSchema.parse(input);
  const url = validUrl(v.url);
  await withUser(user.id, async (tx) => {
    const [before] = await tx<{ url: string; description: string | null; events: string[]; team_id: string | null; enabled: boolean }[]>`
      select url, description, events, team_id, enabled from app.webhook_endpoints where id = ${id} for update
    `;
    if (!before) throw new WebhookError("Webhook not found.");
    const after = { url, description: v.description, events: v.events, team_id: v.teamId, enabled: input.enabled };
    await tx`
      update app.webhook_endpoints set url = ${url}, description = ${v.description}, events = ${v.events}, team_id = ${v.teamId}, enabled = ${input.enabled}
      where id = ${id}
    `;
    const { url: beforeUrl, ...beforeRest } = before;
    const { url: afterUrl, ...afterRest } = after;
    const diff = changedFields({ ...beforeRest, ...auditUrl(beforeUrl) }, { ...afterRest, ...auditUrl(afterUrl) });
    if (diff) {
      await writeAudit(tx, { actorUserId: user.id, action: "webhook.update", entityType: "webhook_endpoint", entityId: id, before: diff.before, after: diff.after });
    }
  });
}

export async function setWebhookEnabled(user: SessionUser, id: string, enabled: boolean): Promise<void> {
  await assertAdmin(user);
  await withUser(user.id, async (tx) => {
    const rows = await tx`update app.webhook_endpoints set enabled = ${enabled} where id = ${id} and enabled <> ${enabled} returning id`;
    if (!rows.length) return;
    await writeAudit(tx, {
      actorUserId: user.id,
      action: enabled ? "webhook.enable" : "webhook.disable",
      entityType: "webhook_endpoint",
      entityId: id,
      before: { enabled: !enabled },
      after: { enabled },
    });
  });
}

/** Replaces the signing secret. Deliveries signed afterwards use the new one. */
export async function rotateWebhookSecret(user: SessionUser, id: string): Promise<{ secret: string }> {
  await assertAdmin(user);
  const { secret, prefix } = newSecret();
  await withUser(user.id, async (tx) => {
    const rows = await tx`update app.webhook_endpoints set secret_enc = ${encryptSecret(secret, id)}, secret_prefix = ${prefix} where id = ${id} returning id`;
    if (!rows.length) throw new WebhookError("Webhook not found.");
    await writeAudit(tx, { actorUserId: user.id, action: "webhook.rotate_secret", entityType: "webhook_endpoint", entityId: id, after: { secretPrefix: prefix } });
  });
  return { secret };
}

export async function deleteWebhook(user: SessionUser, id: string): Promise<void> {
  await assertAdmin(user);
  await withUser(user.id, async (tx) => {
    const [row] = await tx<{ url: string; events: string[] }[]>`delete from app.webhook_endpoints where id = ${id} returning url, events`;
    if (!row) throw new WebhookError("Webhook not found.");
    await writeAudit(tx, { actorUserId: user.id, action: "webhook.delete", entityType: "webhook_endpoint", entityId: id, before: { ...auditUrl(row.url), events: row.events } });
  });
}

/**
 * Queues a webhook.test delivery to one endpoint. Deliveries and jobs are written by the
 * service connection only, so this runs in a service transaction with the actor's claims
 * set: the admin check, the delivery, the job and the audit entry commit together.
 */
export async function sendTestWebhook(user: SessionUser, id: string): Promise<void> {
  const endpointId = z.uuid().safeParse(id);
  if (!endpointId.success) throw new WebhookError("Webhook not found.");
  const actor = z.uuid().parse(user.id);
  const eventId = randomUUID();
  // Deliveries are written by the service connection only. The audit entry is written in
  // the same transaction, so a test delivery never goes out without one.
  await service().begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor })}, true)`;
    const [{ ok }] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
    if (!ok) throw new WebhookError("Admin access required.");
    const [exists] = await tx`select 1 from app.webhook_endpoints where id = ${endpointId.data} for share`;
    if (!exists) throw new WebhookError("Webhook not found.");
    const [d] = await tx<{ id: string }[]>`
      insert into app.webhook_deliveries (endpoint_id, event_id, event, payload)
      values (${endpointId.data}, ${eventId}, 'webhook.test', ${tx.json(testEventBody(eventId, new Date().toISOString()) as never)})
      returning id
    `;
    await enqueue(tx, { kind: "webhook_deliver", payload: { deliveryId: d.id }, idempotencyKey: d.id, maxAttempts: 1 });
    await writeAudit(tx, { actorUserId: actor, action: "webhook.test", entityType: "webhook_endpoint", entityId: endpointId.data });
  });
}
