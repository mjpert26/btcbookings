import "server-only";
import { service, type Db } from "@/server/db/client";
import { env } from "@/server/env";
import { decryptSecret } from "@/server/crypto/aes";
import { isManagedKey, isSecretKey, settingAad, type ManagedKey } from "@/server/settings/keys";

/**
 * Resolved third-party integration configuration: for each managed key, the value set in
 * Admin > Settings (app.integration_settings), else the Vercel environment value, else
 * undefined. EMAIL_FROM keeps the environment default.
 *
 * Panel values are read on the service connection and decrypted only here. They are cached
 * per server instance for CACHE_TTL_MS; a write in this instance invalidates the cache, and
 * other instances pick up the change when their cache expires. When the database cannot be
 * read, the environment values are used and a warning without values is logged.
 *
 * Only the panel values are cached. Environment values are read from env() on every call.
 */
export type IntegrationConfig = {
  RESEND_API_KEY: string | undefined;
  EMAIL_FROM: string;
  SENDBLUE_API_KEY: string | undefined;
  SENDBLUE_API_SECRET: string | undefined;
  SENDBLUE_FROM_NUMBER: string | undefined;
  SENDBLUE_WEBHOOK_SECRET: string | undefined;
  SLACK_BOT_TOKEN: string | undefined;
  SLACK_ADMIN_NOTIFY_CHANNEL: string | undefined;
  TURNSTILE_SITE_KEY: string | undefined;
  TURNSTILE_SECRET_KEY: string | undefined;
  N8N_SIGNING_SECRET: string | undefined;
  SF_SYNC_SIGNING_SECRET: string | undefined;
  SF_QUEUE_PUSH_BEARER: string | undefined;
};

export type PanelValues = Partial<Record<ManagedKey, string>>;

export const CACHE_TTL_MS = 30_000;
/** A failed read is retried after this long, so a database outage does not slow every call. */
const FAILURE_TTL_MS = 5_000;

type CacheState = {
  entry: { values: PanelValues; expiresAt: number } | null;
  inflight: Promise<PanelValues> | null;
  /** Bumped on invalidation so a read that started before a write cannot repopulate the cache. */
  generation: number;
};

// Kept on globalThis so server actions and route handlers in one instance share the cache
// even when the bundler includes this module more than once.
declare global {
  var __btcIntegrationSettings: CacheState | undefined;
}

function state(): CacheState {
  globalThis.__btcIntegrationSettings ??= { entry: null, inflight: null, generation: 0 };
  return globalThis.__btcIntegrationSettings;
}

/** Drops the cached panel values. Called after every write in this instance. */
export function invalidateIntegrationSettings(): void {
  const s = state();
  s.entry = null;
  s.inflight = null;
  s.generation++;
}

/** For tests: resets the cache to its initial state. */
export function resetIntegrationSettingsCache(): void {
  invalidateIntegrationSettings();
}

/** Reads and decrypts every panel value. Throws when the database cannot be read. */
export async function readPanelValues(db: Db): Promise<PanelValues> {
  const rows = await db<{ key: string; is_secret: boolean; value_plain: string | null; value_enc: string | null }[]>`
    select key, is_secret, value_plain, value_enc from app.integration_settings
  `;
  const out: PanelValues = {};
  for (const row of rows) {
    if (!isManagedKey(row.key)) continue;
    const key = row.key;
    if (isSecretKey(key)) {
      if (!row.is_secret || !row.value_enc) continue;
      try {
        out[key] = decryptSecret(row.value_enc, settingAad(key));
      } catch {
        // Wrong key ring, a removed key id, or a ciphertext that belongs to another key.
        console.warn(JSON.stringify({ msg: "integration setting could not be decrypted; using the environment value", key }));
      }
    } else if (!row.is_secret && row.value_plain) {
      out[key] = row.value_plain;
    }
  }
  return out;
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : "unknown";
}

async function loadWithFallback(generation: number): Promise<PanelValues> {
  const s = state();
  try {
    const values = await readPanelValues(service());
    if (s.generation === generation) s.entry = { values, expiresAt: Date.now() + CACHE_TTL_MS };
    return values;
  } catch (err) {
    // Only an error code is logged: never values, connection strings or messages.
    console.warn(JSON.stringify({ msg: "integration settings could not be read; using environment values", code: errorCode(err) }));
    const values: PanelValues = {};
    if (s.generation === generation) s.entry = { values, expiresAt: Date.now() + FAILURE_TTL_MS };
    return values;
  }
}

/** Panel values, from the cache when it is fresh. `fresh` bypasses the cache. Never throws. */
export async function panelValues(opts: { fresh?: boolean } = {}): Promise<PanelValues> {
  const s = state();
  if (!opts.fresh) {
    if (s.entry && s.entry.expiresAt > Date.now()) return s.entry.values;
    if (s.inflight) return s.inflight;
  }
  const load = loadWithFallback(s.generation);
  if (!opts.fresh) {
    s.inflight = load;
    void load.finally(() => {
      if (s.inflight === load) s.inflight = null;
    });
  }
  return load;
}

/**
 * The resolved configuration. `fresh` reads the database instead of the cache, for the
 * test buttons in Admin > Settings. Throws only when the environment itself is invalid,
 * like env().
 */
export async function integrationSettings(opts: { fresh?: boolean } = {}): Promise<IntegrationConfig> {
  const e = env();
  const p = await panelValues(opts);
  return {
    RESEND_API_KEY: p.RESEND_API_KEY ?? e.RESEND_API_KEY,
    EMAIL_FROM: p.EMAIL_FROM ?? e.EMAIL_FROM,
    SENDBLUE_API_KEY: p.SENDBLUE_API_KEY ?? e.SENDBLUE_API_KEY,
    SENDBLUE_API_SECRET: p.SENDBLUE_API_SECRET ?? e.SENDBLUE_API_SECRET,
    SENDBLUE_FROM_NUMBER: p.SENDBLUE_FROM_NUMBER ?? e.SENDBLUE_FROM_NUMBER,
    SENDBLUE_WEBHOOK_SECRET: p.SENDBLUE_WEBHOOK_SECRET ?? e.SENDBLUE_WEBHOOK_SECRET,
    SLACK_BOT_TOKEN: p.SLACK_BOT_TOKEN ?? e.SLACK_BOT_TOKEN,
    SLACK_ADMIN_NOTIFY_CHANNEL: p.SLACK_ADMIN_NOTIFY_CHANNEL ?? e.SLACK_ADMIN_NOTIFY_CHANNEL,
    TURNSTILE_SITE_KEY: p.TURNSTILE_SITE_KEY ?? e.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: p.TURNSTILE_SECRET_KEY ?? e.TURNSTILE_SECRET_KEY,
    N8N_SIGNING_SECRET: p.N8N_SIGNING_SECRET ?? e.N8N_SIGNING_SECRET,
    SF_SYNC_SIGNING_SECRET: p.SF_SYNC_SIGNING_SECRET ?? e.SF_SYNC_SIGNING_SECRET,
    SF_QUEUE_PUSH_BEARER: p.SF_QUEUE_PUSH_BEARER ?? e.SF_QUEUE_PUSH_BEARER,
  };
}

/**
 * Where a key's value comes from: set in Admin > Settings, the Vercel environment, the
 * built-in default (EMAIL_FROM only), or nowhere.
 */
export type SettingSource = "panel" | "vercel" | "default" | "unset";

/**
 * A key's environment value and source, ignoring the panel. For the Admin > Settings page
 * and its audit entries, which show the environment value's source and, for secrets, only
 * its last four characters.
 */
export function environmentState(
  key: ManagedKey,
  processEnv: Record<string, string | undefined> = process.env,
): { source: SettingSource; value: string | undefined } {
  const value = env()[key];
  if (key === "EMAIL_FROM" && !processEnv.EMAIL_FROM) {
    return { source: "default", value: typeof value === "string" && value !== "" ? value : undefined };
  }
  if (typeof value === "string" && value !== "") return { source: "vercel", value };
  return { source: "unset", value: undefined };
}

/**
 * The Turnstile site key for the public booking forms, or null. This is the only setting
 * that public pages read; it is public by design. Use it instead of integrationSettings() in
 * components so no secret is ever in scope where props for client components are built.
 */
export async function turnstileSiteKey(): Promise<string | null> {
  return (await integrationSettings()).TURNSTILE_SITE_KEY || null;
}
