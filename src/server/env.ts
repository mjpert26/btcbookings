import "server-only";
import { z } from "zod";

/**
 * Server environment. Validated lazily on first access so that `next build` does not
 * require production secrets. Every variable is documented in .env.example.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Trailing slashes are stripped so "${APP_BASE_URL}/api/..." never produces "//".
  APP_BASE_URL: z.string().url().transform((v) => v.replace(/\/+$/, "")),
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

  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("BTC Scheduling <scheduling@bigthinkcapital.com>"),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_ADMIN_NOTIFY_CHANNEL: z.string().optional(),

  N8N_BASE_URL: z.string().url().default("https://api.bigthinkcapital.com"),
  N8N_LEAD_WEBHOOK_PATH: z.string().default("/webhook/btc-scheduler/lead"),
  N8N_SIGNING_SECRET: z.string().optional(),
  SF_SYNC_SIGNING_SECRET: z.string().optional(),
  SF_QUEUE_PUSH_BEARER: z.string().optional(),
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
