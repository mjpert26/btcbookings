import "server-only";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { encryptSecret } from "@/server/crypto/aes";
import type { SessionUser } from "@/server/auth/session";
import { environmentState, invalidateIntegrationSettings, type SettingSource } from "@/server/settings/integrations";
import { isManagedKey, isSecretKey, KEY_INFO, last4, parseSettingValue, settingAad, type ManagedKey, MANAGED_KEYS } from "@/server/settings/keys";

/**
 * Admin > Settings: set, replace and remove integration keys. Every function runs as the
 * signed-in user under row-level security, checks app.is_admin(), and writes the audit entry
 * in the same transaction as the change. Audit entries hold only { key, source, last4 }:
 * never a value. Secrets are encrypted before they reach the database and are never read
 * back here; only their last four characters are.
 */

export class SettingsError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid" | "unknown_key" | "not_set" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export type { SettingSource };

export type SettingView = {
  key: ManagedKey;
  label: string;
  hint: string;
  placeholder: string | null;
  isSecret: boolean;
  source: SettingSource;
  /** Secrets only: the last four characters of the active value. */
  last4: string | null;
  /** Plain keys only: the active value. */
  value: string | null;
  /** Panel values only. */
  updatedByName: string | null;
  updatedAt: Date | null;
};

/** The audit view of a key's state. Never contains a value. */
export type SettingAuditView = { key: ManagedKey; source: SettingSource; last4: string | null };

async function requireAdmin(tx: Tx): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!row?.ok) throw new SettingsError("forbidden", "Admin access required.");
}

function parseKey(key: unknown): ManagedKey {
  if (!isManagedKey(key)) throw new SettingsError("unknown_key", "Unknown setting.");
  return key;
}

function environmentAuditView(key: ManagedKey): SettingAuditView {
  const state = environmentState(key);
  return { key, source: state.source, last4: isSecretKey(key) && state.value ? last4(state.value) : null };
}

type PanelRow = { key: string; is_secret: boolean; value_plain: string | null; last4: string | null; updated_at: Date; updated_by_name: string | null };

/** Every managed key with its source and display value. Secrets show only last4. */
export async function listIntegrationSettings(user: SessionUser): Promise<SettingView[]> {
  const rows = await withUser(user.id, async (tx) => {
    await requireAdmin(tx);
    // value_enc is not selectable by app_user; only metadata and plain values are read.
    return tx<PanelRow[]>`
      select s.key, s.is_secret, s.value_plain, s.last4, s.updated_at, u.name as updated_by_name
      from app.integration_settings s left join app.users u on u.id = s.updated_by
    `;
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return MANAGED_KEYS.map((key): SettingView => {
    const info = KEY_INFO[key];
    const secret = isSecretKey(key);
    const row = byKey.get(key);
    const base = { key, label: info.label, hint: info.hint, placeholder: info.placeholder ?? null, isSecret: secret };
    if (row) {
      return {
        ...base,
        source: "panel",
        last4: secret ? row.last4 : null,
        value: secret ? null : row.value_plain,
        updatedByName: row.updated_by_name,
        updatedAt: row.updated_at,
      };
    }
    const state = environmentState(key);
    return {
      ...base,
      source: state.source,
      last4: secret && state.value ? last4(state.value) : null,
      value: !secret && state.value ? state.value : null,
      updatedByName: null,
      updatedAt: null,
    };
  });
}

/**
 * Sets or replaces a key's panel value. The value is validated with the same rule env.ts
 * applies to the variable. Secrets are encrypted with the key name as the encryption context.
 */
export async function setIntegrationSetting(user: SessionUser, keyInput: unknown, rawValue: unknown): Promise<SettingAuditView> {
  const key = parseKey(keyInput);
  const parsed = parseSettingValue(key, rawValue);
  if (!parsed.ok) throw new SettingsError("invalid", parsed.error);
  const value = parsed.value;
  const secret = isSecretKey(key);
  const valueEnc = secret ? encryptSecret(value, settingAad(key)) : null;
  const valuePlain = secret ? null : value;
  const valueLast4 = secret ? last4(value) : null;
  const after: SettingAuditView = { key, source: "panel", last4: valueLast4 };

  try {
    await withUser(user.id, async (tx) => {
      await requireAdmin(tx);
      const [existing] = await tx<{ last4: string | null }[]>`
        select last4 from app.integration_settings where key = ${key} for update
      `;
      const before: SettingAuditView = existing ? { key, source: "panel", last4: existing.last4 } : environmentAuditView(key);
      if (existing) {
        await tx`
          update app.integration_settings
          set value_plain = ${valuePlain}, value_enc = ${valueEnc}, last4 = ${valueLast4}, updated_by = ${user.id}
          where key = ${key}
        `;
      } else {
        await tx`
          insert into app.integration_settings (key, is_secret, value_plain, value_enc, last4, updated_by)
          values (${key}, ${secret}, ${valuePlain}, ${valueEnc}, ${valueLast4}, ${user.id})
        `;
      }
      await writeAudit(tx, {
        actorUserId: user.id,
        action: "settings.update",
        entityType: "integration_setting",
        entityId: key,
        before,
        after,
      });
    });
  } catch (err) {
    // Two admins saving the same new key at once: the second insert hits the primary key.
    if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "23505") {
      throw new SettingsError("conflict", "Another admin changed this setting at the same time. Reload the page and try again.");
    }
    throw err;
  } finally {
    invalidateIntegrationSettings();
  }
  return after;
}

/** Removes a key's panel value. The app falls back to the Vercel environment value. */
export async function removeIntegrationSetting(user: SessionUser, keyInput: unknown): Promise<SettingAuditView> {
  const key = parseKey(keyInput);
  const after = environmentAuditView(key);
  try {
    await withUser(user.id, async (tx) => {
      await requireAdmin(tx);
      const [existing] = await tx<{ last4: string | null }[]>`
        delete from app.integration_settings where key = ${key} returning last4
      `;
      if (!existing) throw new SettingsError("not_set", "This setting has no value in Admin > Settings.");
      await writeAudit(tx, {
        actorUserId: user.id,
        action: "settings.remove",
        entityType: "integration_setting",
        entityId: key,
        before: { key, source: "panel", last4: existing.last4 } satisfies SettingAuditView,
        after,
      });
    });
  } finally {
    invalidateIntegrationSettings();
  }
  return after;
}
