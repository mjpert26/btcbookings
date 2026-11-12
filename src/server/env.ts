import "server-only";
import { z } from "zod";

/** E.164 phone number, for example +15551234567. */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

export const DEFAULT_EMAIL_FROM = "BTC Scheduling <scheduling@bigthinkcapital.com>";

/**
 * Value rules for the integration keys that Admin > Settings can also set. The environment
 * schema below and the settings panel (src/server/settings/keys.ts) both use them, so the
 * panel accepts exactly the values the environment accepts.
 */
export const integrationValueRules = {
  TURNSTILE_SITE_KEY: z.string(),
  TURNSTILE_SECRET_KEY: z.string(),
  RESEND_API_KEY: z.string(),
  EMAIL_FROM: z.string(),
  SLACK_BOT_TOKEN: z.string(),
  SLACK_ADMIN_NOTIFY_CHANNEL: z.string(),
  SENDBLUE_API_KEY: z.string(),
  SENDBLUE_API_SECRET: z.string(),
  SENDBLUE_FROM_NUMBER: z.string().regex(E164_RE),
  SENDBLUE_WEBHOOK_SECRET: z.string().min(16),
  N8N_SIGNING_SECRET: z.string(),
  SF_SYNC_SIGNING_SECRET: z.string(),
  SF_QUEUE_PUSH_BEARER: z.string(),
} as const;

const rules = integrationValueRules;
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

/**
 * Server environment. Validated lazily on first access so that `next build` does not
 * require production secrets. Every variable is documented in .env.example.
 *
 * The keys in integrationValueRules are read through integrationSettings()
 * (src/server/settings/integrations.ts), not through env(): a value set in Admin > Settings
 * overrides the environment.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Trailing slashes are stripped so "${APP_BASE_URL}/api/..." never produces "//".
  APP_BASE_URL: z.string().url().transform((v) => v.replace(/\/+$/, "")),
  // Public origin of the MCP server. The MCP endpoint is "<origin>/mcp". Defaults to
  // APP_BASE_URL. Never mcp.bigthinkcapital.com: that host is the BTC MCP Gateway.
  MCP_BASE_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .url()
      .transform((v) => v.replace(/\/+$/, ""))
      .optional(),
  ),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

  ENTRA_TENANT_ID: z.string().uuid(),
  ENTRA_CLIENT_ID: z.string().uuid(),
  ENTRA_CLIENT_SECRET: z.string().min(1),
  ALLOWED_EMAIL_DOMAINS: z.string().default("bigthinkcapital.com"),
  ADMIN_EMAILS: z.string().default(""),

  // "kid1:base64key,kid2:base64key". Keys are 32 bytes. The active key encrypts; all keys decrypt.
  TOKEN_ENCRYPTION_KEYS: z.string().min(1),
  TOKEN_ENCRYPTION_ACTIVE_KID: z.string().min(1),
  IP_HASH_SALT: z.string().min(16),

  CRON_SECRET: z.string().min(16),

  TURNSTILE_SITE_KEY: rules.TURNSTILE_SITE_KEY.optional(),
  TURNSTILE_SECRET_KEY: rules.TURNSTILE_SECRET_KEY.optional(),
  // Comma-separated frontend hostnames whose Turnstile tokens the server accepts. Defaults to
  // the hostname of APP_BASE_URL. localhost and 127.0.0.1 are ignored in production.
  TURNSTILE_HOSTNAMES: z.preprocess(emptyToUndefined, z.string().max(1000).optional()),

  RESEND_API_KEY: rules.RESEND_API_KEY.optional(),
  EMAIL_FROM: rules.EMAIL_FROM.default(DEFAULT_EMAIL_FROM),

  SLACK_BOT_TOKEN: rules.SLACK_BOT_TOKEN.optional(),
  SLACK_ADMIN_NOTIFY_CHANNEL: rules.SLACK_ADMIN_NOTIFY_CHANNEL.optional(),

  // SendBlue SMS. Without the key and secret, text messages are logged and not sent.
  SENDBLUE_API_KEY: rules.SENDBLUE_API_KEY.optional(),
  SENDBLUE_API_SECRET: rules.SENDBLUE_API_SECRET.optional(),
  SENDBLUE_FROM_NUMBER: z.preprocess(emptyToUndefined, rules.SENDBLUE_FROM_NUMBER.optional()),
  // Shared secret SendBlue sends in the sb-signing-secret header of inbound webhooks.
  SENDBLUE_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, rules.SENDBLUE_WEBHOOK_SECRET.optional()),

  N8N_BASE_URL: z.string().url().default("https://api.bigthinkcapital.com"),
  N8N_LEAD_WEBHOOK_PATH: z.string().default("/webhook/btc-scheduler/lead"),
  N8N_SIGNING_SECRET: rules.N8N_SIGNING_SECRET.optional(),
  SF_SYNC_SIGNING_SECRET: rules.SF_SYNC_SIGNING_SECRET.optional(),
  SF_QUEUE_PUSH_BEARER: rules.SF_QUEUE_PUSH_BEARER.optional(),
  SF_LEAD_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  QUEUE_POLL_STALE_MINUTES: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof schema>;

/** Thrown when required configuration is missing or invalid. The message lists variable names only. */
export class EnvConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid server environment. Missing or invalid: ${variables.join(", ")}`);
    this.name = "EnvConfigError";
  }
}

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Only variable names are reported, never values.
    throw new EnvConfigError([...new Set(parsed.error.issues.map((i) => i.path.join(".")))]);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only. */
export function resetEnvCache(): void {
  cached = null;
}

export function adminEmails(): string[] {
  return env()
    .ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedEmailDomains(): string[] {
  return env()
    .ALLOWED_EMAIL_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}
