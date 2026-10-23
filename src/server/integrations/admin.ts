import "server-only";
import { withUser } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { checkRedirectPattern, checkRedirectUri } from "@/lib/oauth-redirects";
import { createApiKey, registerClient } from "@/server/oauth/server";
import type { SessionUser } from "@/server/auth/session";

/**
 * Settings behind Settings > Integrations (every user: API keys and connected apps) and
 * Admin > Integrations (admins: allowed callback URLs, OAuth clients, all tokens). Runs under
 * RLS as the signed-in user; admin functions also check app.is_admin(). All changes are audited.
 */

export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

async function assertAdmin(user: SessionUser): Promise<void> {
  const ok = await withUser(user.id, async (tx) => (await tx<{ ok: boolean }[]>`select app.is_admin() as ok`)[0]?.ok);
  if (!ok) throw new IntegrationError("Admin access required.");
}

export type ApiKeyRow = { id: string; name: string | null; prefix: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null };
export type ConnectedApp = { client_id: string; name: string; connected_at: Date; last_used_at: Date | null };

export async function myIntegrations(user: SessionUser): Promise<{ keys: ApiKeyRow[]; apps: ConnectedApp[] }> {
  return withUser(user.id, async (tx) => {
    const keys = await tx<ApiKeyRow[]>`
      select id, name, prefix, created_at, last_used_at, expires_at from app.api_tokens
      where user_id = ${user.id} and kind = 'api_key' and revoked_at is null and (expires_at is null or expires_at > now())
      order by created_at desc
    `;
    const apps = await tx<ConnectedApp[]>`
      select t.client_id, c.name, min(t.created_at) as connected_at, max(t.last_used_at) as last_used_at
      from app.api_tokens t join app.oauth_clients c on c.client_id = t.client_id
      where t.user_id = ${user.id} and t.kind = 'oauth_refresh' and t.revoked_at is null and t.expires_at > now()
      group by t.client_id, c.name
      order by c.name
    `;
    return { keys, apps };
  });
}

export async function createMyApiKey(user: SessionUser, name: string, expiresInDays: number | null): Promise<{ key: string; prefix: string }> {
  const label = name.trim().slice(0, 100);
  if (!label) throw new IntegrationError("Name the key so you can recognize it later.");
  const created = await createApiKey(user.id, label, { expiresInDays });
  await withUser(user.id, (tx) =>
    writeAudit(tx, { actorUserId: user.id, action: "api_key.create", entityType: "api_token", entityId: created.id, after: { name: label, prefix: created.prefix, expiresInDays } }),
  );
  return { key: created.key, prefix: created.prefix };
}

/** Revokes one of the user's API keys, or any token when the user is an admin. */
export async function revokeToken(user: SessionUser, tokenId: string): Promise<boolean> {
  return withUser(user.id, async (tx) => {
    const rows = await tx<{ id: string; prefix: string; user_id: string }[]>`
      update app.api_tokens set revoked_at = now() where id = ${tokenId} and revoked_at is null returning id, prefix, user_id
    `;
    if (!rows.length) return false;
    await writeAudit(tx, { actorUserId: user.id, action: "api_token.revoke", entityType: "api_token", entityId: tokenId, after: { prefix: rows[0].prefix, userId: rows[0].user_id } });
    return true;
  });
}

/** Disconnects an app for the user: every token it holds for them stops working. */
export async function disconnectApp(user: SessionUser, clientId: string): Promise<number> {
  return withUser(user.id, async (tx) => {
    const rows = await tx`
      update app.api_tokens set revoked_at = now()
      where user_id = ${user.id} and client_id = ${clientId} and revoked_at is null
      returning id
    `;
    if (rows.length) await writeAudit(tx, { actorUserId: user.id, action: "oauth.disconnect", entityType: "oauth_client", entityId: clientId, after: { tokens: rows.length } });
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type AllowlistRow = { id: string; pattern: string; note: string | null; created_at: Date };
export type ClientRow = { client_id: string; name: string; redirect_uris: string[]; registered_via: string; disabled_at: Date | null; created_at: Date; last_used_at: Date | null; users: number };
export type TokenRow = { id: string; kind: string; prefix: string; name: string | null; user_name: string; client_name: string | null; created_at: Date; last_used_at: Date | null; expires_at: Date | null };

export async function adminIntegrations(user: SessionUser): Promise<{ allowlist: AllowlistRow[]; clients: ClientRow[]; tokens: TokenRow[] }> {
  await assertAdmin(user);
  return withUser(user.id, async (tx) => {
    const allowlist = await tx<AllowlistRow[]>`select id, pattern, note, created_at from app.oauth_redirect_allowlist order by created_at`;
    const clients = await tx<ClientRow[]>`
      select c.client_id, c.name, c.redirect_uris, c.registered_via, c.disabled_at, c.created_at, c.last_used_at,
             (select count(distinct t.user_id)::int from app.api_tokens t
               where t.client_id = c.client_id and t.kind = 'oauth_refresh' and t.revoked_at is null and t.expires_at > now()) as users
      from app.oauth_clients c
      order by c.last_used_at desc nulls last, c.created_at desc
      limit 200
    `;
    const tokens = await tx<TokenRow[]>`
      select t.id, t.kind, t.prefix, t.name, u.name as user_name, c.name as client_name, t.created_at, t.last_used_at, t.expires_at
      from app.api_tokens t join app.users u on u.id = t.user_id left join app.oauth_clients c on c.client_id = t.client_id
      where t.kind in ('api_key', 'oauth_refresh') and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
      order by t.last_used_at desc nulls last, t.created_at desc
      limit 300
    `;
    return { allowlist, clients, tokens };
  });
}

export async function addAllowedCallback(user: SessionUser, pattern: string, note: string): Promise<void> {
  await assertAdmin(user);
  const p = pattern.trim();
  const check = checkRedirectPattern(p);
  if (!check.ok) throw new IntegrationError(`Callback URL ${check.reason}.`);
  await withUser(user.id, async (tx) => {
    const rows = await tx`
      insert into app.oauth_redirect_allowlist (pattern, note, created_by) values (${p}, ${note.trim().slice(0, 200) || null}, ${user.id})
      on conflict (pattern) do nothing returning id
    `;
    if (!rows.length) throw new IntegrationError("That callback URL is already allowed.");
    await writeAudit(tx, { actorUserId: user.id, action: "oauth.allowlist_add", entityType: "oauth_allowlist", entityId: String(rows[0].id), after: { pattern: p } });
  });
}

export async function removeAllowedCallback(user: SessionUser, id: string): Promise<void> {
  await assertAdmin(user);
  await withUser(user.id, async (tx) => {
    const [row] = await tx<{ pattern: string }[]>`delete from app.oauth_redirect_allowlist where id = ${id} returning pattern`;
    if (row) await writeAudit(tx, { actorUserId: user.id, action: "oauth.allowlist_remove", entityType: "oauth_allowlist", entityId: id, before: { pattern: row.pattern } });
  });
}

/** Registers a client by hand for apps that do not support dynamic registration. */
export async function registerClientManually(user: SessionUser, name: string, callbacks: string[]): Promise<string> {
  await assertAdmin(user);
  const uris = callbacks.map((c) => c.trim()).filter(Boolean);
  for (const u of uris) {
    const check = checkRedirectUri(u);
    if (!check.ok) throw new IntegrationError(`${u.slice(0, 100)}: ${check.reason}.`);
  }
  // Manually registered callbacks are added to the allowlist so the same rules apply at sign-in.
  return withUser(user.id, async (tx) => {
    for (const u of uris) {
      await tx`insert into app.oauth_redirect_allowlist (pattern, note, created_by) values (${u}, ${`Registered for ${name.slice(0, 100)}`}, ${user.id}) on conflict (pattern) do nothing`;
    }
    const client = await registerClient({ client_name: name, redirect_uris: uris }, { via: "admin", createdBy: user.id, db: tx });
    await writeAudit(tx, { actorUserId: user.id, action: "oauth.client_register", entityType: "oauth_client", entityId: client.client_id, after: { name: client.name, redirectUris: uris } });
    return client.client_id;
  });
}

export async function setClientDisabled(user: SessionUser, clientId: string, disabled: boolean): Promise<void> {
  await assertAdmin(user);
  await withUser(user.id, async (tx) => {
    const rows = await tx`
      update app.oauth_clients set disabled_at = ${disabled ? new Date() : null} where client_id = ${clientId} returning client_id
    `;
    if (!rows.length) throw new IntegrationError("Client not found.");
    if (disabled) await tx`update app.api_tokens set revoked_at = now() where client_id = ${clientId} and revoked_at is null`;
    await writeAudit(tx, { actorUserId: user.id, action: disabled ? "oauth.client_disable" : "oauth.client_enable", entityType: "oauth_client", entityId: clientId });
  });
}
