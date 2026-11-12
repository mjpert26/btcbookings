import "server-only";
import { service, type Db } from "@/server/db/client";
import { env } from "@/server/env";
import { decryptSecret } from "@/server/crypto/aes";
import { isManagedKey, isSecretKey, MANAGED_KEYS, settingAad, type ManagedKey } from "@/server/settings/keys";

/**
 * Resolved third-party integration configuration: for each managed key, the value set in
 * Admin > Settings (app.integration_settings), else the Vercel environment value, else
 * undefined. EMAIL_FROM keeps the environment default.
 *
 * Panel values are read on the service connection and decrypted only here. They are cached
 * per server instance for CACHE_TTL_MS; a write in this instance invalidates the cache, and
 * other instances pick up the change when their cache expires. Each read is bounded by
 * READ_LIMITS. When a read fails, the values of the last successful read in this instance are
 * used; when no read has succeeded yet, the environment values are used and every key is
 * listed in `unavailable`. Failures are logged with an error code only, never with values.
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
  /**
   * Keys whose Admin > Settings value could not be determined on this instance: the table
   * could not be read and no earlier read had succeeded, or the stored secret does not
   * decrypt. These keys resolve to the environment value. See settingUnavailable().
   */
  unavailable: readonly ManagedKey[];
};

export type PanelValues = Partial<Record<ManagedKey, string>>;

/** One read of app.integration_settings: the usable values and the secrets that did not decrypt. */
export type PanelRead = { values: PanelValues; unreadable: readonly ManagedKey[] };

/** What this instance knows about the panel. `known` is false when no read has succeeded yet. */
export type PanelState = PanelRead & { known: boolean };

export const CACHE_TTL_MS = 30_000;
/** A failed read is retried after this long, so a database outage does not slow every call. */
const FAILURE_TTL_MS = 5_000;
/**
 * Bounds on one read, so a slow or blocked query never stalls every caller on the instance:
 * lock and statement timeouts in the database, and an overall deadline that also covers the
 * wait for a pool connection.
 */
export const READ_LIMITS = { lockTimeoutMs: 1_000, statementTimeoutMs: 2_000, overallMs: 2_500 } as const;

type CacheState = {
  entry: { state: PanelState; expiresAt: number } | null;
  inflight: Promise<PanelState> | null;
  /** Bumped on invalidation so a read that started before a write cannot repopulate the cache. */
  generation: number;
  /** The last successful read in this instance. Used when a later read fails. */
  lastGood: PanelRead | null;
};

// Kept on globalThis so server actions and route handlers in one instance share the cache
// even when the bundler includes this module more than once.
declare global {
  var __btcIntegrationSettings: CacheState | undefined;
}

function state(): CacheState {
  globalThis.__btcIntegrationSettings ??= { entry: null, inflight: null, generation: 0, lastGood: null };
  return globalThis.__btcIntegrationSettings;
}

/**
 * Drops the cached panel values. Called after every write in this instance. The last
 * successful read is kept as the fallback for a failed read.
 */
export function invalidateIntegrationSettings(): void {
  const s = state();
  s.entry = null;
  s.inflight = null;
  s.generation++;
}

/** For tests: resets the cache, including the last successful read, to its initial state. */
export function resetIntegrationSettingsCache(): void {
  invalidateIntegrationSettings();
  state().lastGood = null;
}

/**
 * Thrown where a missing key would otherwise mean "skip": the key has no value, but it may
 * be set in Admin > Settings and could not be read (see IntegrationConfig.unavailable). Not a
 * PermanentJobError, so jobs are retried instead of finishing without sending.
 */
export class IntegrationSettingUnavailableError extends Error {
  constructor(readonly key: ManagedKey) {
    super(`${key} could not be read from Admin > Settings. Try again shortly.`);
    this.name = "IntegrationSettingUnavailableError";
  }
}

/**
 * True when `key` has no value in `config` but may be set in Admin > Settings: the panel
 * could not be read on this instance, or the stored secret does not decrypt. Callers that
 * skip work when a key is missing should fail (and retry) instead.
 */
export function settingUnavailable<K extends ManagedKey>(
  config: Partial<Pick<IntegrationConfig, K>> & { unavailable?: readonly ManagedKey[] },
  key: K,
): boolean {
  return !config[key] && (config.unavailable?.includes(key) ?? false);
}

/** Reads and decrypts every panel value. Throws when the database cannot be read. */
export async function readPanelValues(db: Db): Promise<PanelRead> {
  const rows = await db<{ key: string; is_secret: boolean; value_plain: string | null; value_enc: string | null }[]>`
    select key, is_secret, value_plain, value_enc from app.integration_settings
  `;
  const values: PanelValues = {};
  const unreadable: ManagedKey[] = [];
  for (const row of rows) {
    if (!isManagedKey(row.key)) continue;
    const key = row.key;
    if (isSecretKey(key)) {
      if (!row.is_secret || !row.value_enc) continue;
      try {
        values[key] = decryptSecret(row.value_enc, settingAad(key));
      } catch {
        // Wrong key ring, a removed key id, or a ciphertext that belongs to another key.
        unreadable.push(key);
        console.warn(JSON.stringify({ msg: "integration setting could not be decrypted; using the environment value", key }));
      }
    } else if (!row.is_secret && row.value_plain) {
      values[key] = row.value_plain;
    }
  }
  return { values, unreadable };
}

class SettingsReadTimeout extends Error {
  code = "settings_read_timeout";
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SettingsReadTimeout()), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** One read on the service connection, within READ_LIMITS. */
async function readBounded(): Promise<PanelRead> {
  const read = service().begin(async (tx) => {
    await tx.unsafe(`set local lock_timeout = ${READ_LIMITS.lockTimeoutMs}`);
    await tx.unsafe(`set local statement_timeout = ${READ_LIMITS.statementTimeoutMs}`);
    return readPanelValues(tx);
  }) as Promise<PanelRead>;
  return withDeadline(read, READ_LIMITS.overallMs);
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : "unknown";
}

async function loadWithFallback(generation: number): Promise<PanelState> {
  const s = state();
  try {
    const read = await readBounded();
    // A read that started before a write may be older than one that finished since.
    if (s.generation === generation || !s.lastGood) s.lastGood = read;
    const loaded: PanelState = { ...read, known: true };
    if (s.generation === generation) s.entry = { state: loaded, expiresAt: Date.now() + CACHE_TTL_MS };
    return loaded;
  } catch (err) {
    const lastGood = s.lastGood ?? null;
    // Only an error code is logged: never values, connection strings or messages.
    console.warn(
      JSON.stringify({
        msg: lastGood
          ? "integration settings could not be read; using the last values read"
          : "integration settings could not be read; using environment values",
        code: errorCode(err),
      }),
    );
    const fallback: PanelState = lastGood ? { ...lastGood, known: true } : { values: {}, unreadable: [], known: false };
    // A failed read never replaces a cache entry that is still fresh.
    const entryFresh = s.entry !== null && s.entry.expiresAt > Date.now();
    if (s.generation === generation && !entryFresh) s.entry = { state: fallback, expiresAt: Date.now() + FAILURE_TTL_MS };
    return fallback;
  }
}

/** The panel state, from the cache when it is fresh. `fresh` bypasses the cache. Never throws. */
export async function panelState(opts: { fresh?: boolean } = {}): Promise<PanelState> {
  const s = state();
  if (!opts.fresh) {
    if (s.entry && s.entry.expiresAt > Date.now()) return s.entry.state;
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
  const panel = await panelState(opts);
  const p = panel.values;
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
    unavailable: panel.known ? panel.unreadable : MANAGED_KEYS,
  };
}

/**
 * For Admin > Settings: a fresh read on the service connection that reports, by key name
 * only, which stored secrets do not decrypt with the current key ring. `known` is false when
 * the table could not be read and no earlier read succeeded, so the app is using environment
 * values for every key. Never returns values.
 */
export async function panelReadStatus(): Promise<{ known: boolean; unreadable: readonly ManagedKey[] }> {
  const panel = await panelState({ fresh: true });
  return { known: panel.known, unreadable: panel.unreadable };
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
