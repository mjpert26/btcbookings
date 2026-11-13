import "server-only";
import { z } from "zod";
import { integrationValueRules } from "@/server/env";

/**
 * The integration keys that Admin > Settings manages, how they are grouped on the page, and
 * how a submitted value is validated. The list must match the check constraints of
 * app.integration_settings (migration 20261112120000_integration_settings.sql).
 *
 * URLs the app sends signed requests to (N8N_BASE_URL, N8N_LEAD_WEBHOOK_PATH) and bootstrap
 * secrets are deliberately not managed here: they stay in the Vercel environment.
 */

/** Write-only keys, stored encrypted. Only the last four characters are ever shown. */
export const SECRET_KEYS = [
  "RESEND_API_KEY",
  "SENDBLUE_API_KEY",
  "SENDBLUE_API_SECRET",
  "SENDBLUE_WEBHOOK_SECRET",
  "SLACK_BOT_TOKEN",
  "TURNSTILE_SECRET_KEY",
  "N8N_SIGNING_SECRET",
  "SF_SYNC_SIGNING_SECRET",
  "SF_QUEUE_PUSH_BEARER",
] as const;

/** Keys that are not secret. They are stored and shown in full. */
export const PLAIN_KEYS = ["EMAIL_FROM", "SENDBLUE_FROM_NUMBER", "SLACK_ADMIN_NOTIFY_CHANNEL", "TURNSTILE_SITE_KEY"] as const;

export const MANAGED_KEYS = [...SECRET_KEYS, ...PLAIN_KEYS] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
export type PlainKey = (typeof PLAIN_KEYS)[number];
export type ManagedKey = (typeof MANAGED_KEYS)[number];

const SECRET_SET: ReadonlySet<string> = new Set(SECRET_KEYS);
const MANAGED_SET: ReadonlySet<string> = new Set(MANAGED_KEYS);

export function isManagedKey(value: unknown): value is ManagedKey {
  return typeof value === "string" && MANAGED_SET.has(value);
}

export function isSecretKey(key: ManagedKey): key is SecretKey {
  return SECRET_SET.has(key);
}

/** Encryption context of a stored secret. A ciphertext copied to another key's row does not decrypt. */
export function settingAad(key: ManagedKey): string {
  return `integration_setting:${key}`;
}

/**
 * Shortest secret whose last four characters are shown. Below this length the last four
 * characters would give away too much of the value (or all of it), so none are shown.
 */
export const LAST4_MIN_LENGTH = 16;

/**
 * The last four characters of a secret, for display and the audit log, or null when the
 * secret is shorter than LAST4_MIN_LENGTH characters.
 */
export function last4(value: string): string | null {
  return value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null;
}

export type KeyInfo = {
  label: string;
  hint: string;
  /** Shown when the value fails the key's own rule (see integrationValueRules in env.ts). */
  invalid?: string;
  placeholder?: string;
};

export const KEY_INFO: Record<ManagedKey, KeyInfo> = {
  RESEND_API_KEY: { label: "Resend API key", hint: "Starts with re_. Without a key, emails are logged instead of sent.", placeholder: "re_…" },
  EMAIL_FROM: {
    label: "From address",
    hint: "Sender of every email, for example BTC Scheduling <scheduling@bigthinkcapital.com>. The domain must be verified in Resend.",
  },
  SENDBLUE_API_KEY: { label: "SendBlue API key ID", hint: "Without the key ID, secret and sending number, text messages are logged instead of sent." },
  SENDBLUE_API_SECRET: { label: "SendBlue API secret key", hint: "The secret key that belongs to the key ID." },
  SENDBLUE_FROM_NUMBER: {
    label: "Sending number",
    hint: "Required. The only SendBlue line the scheduler texts from, in E.164 format. Texts are not sent without it, and STOP or START replies that arrive on other lines are ignored.",
    invalid: "Use E.164 format: a plus sign and 8 to 15 digits, for example +15551234567.",
    placeholder: "+15551234567",
  },
  SENDBLUE_WEBHOOK_SECRET: {
    label: "Receive webhook signing secret",
    hint: "The secret SendBlue sends in the sb-signing-secret header to /api/sms/inbound (STOP and START replies).",
    invalid: "Use at least 16 characters.",
  },
  SLACK_BOT_TOKEN: { label: "Bot token", hint: "The xoxb- token of the BTC Scheduler Slack app.", placeholder: "xoxb-…" },
  SLACK_ADMIN_NOTIFY_CHANNEL: {
    label: "Admin notice channel",
    hint: "Channel id for sync notices when a linked channel has no notice channel of its own.",
    placeholder: "C0123456789",
  },
  TURNSTILE_SITE_KEY: { label: "Site key", hint: "Public key the booking forms use to show the Turnstile check. Set it together with the secret key." },
  TURNSTILE_SECRET_KEY: { label: "Secret key", hint: "Verifies Turnstile tokens on the server. Set it together with the site key." },
  N8N_SIGNING_SECRET: {
    label: "App-to-n8n signing secret",
    hint: "Signs Salesforce lead requests and Sync now requests to n8n. Must equal BTC_SCHEDULER_N8N_SIGNING_SECRET in n8n.",
  },
  SF_SYNC_SIGNING_SECRET: {
    label: "Queue sync signing secret",
    hint: "Verifies queue snapshots and pushes signed by n8n or Apex. Must equal BTC_SCHEDULER_SIGNING_SECRET in n8n.",
  },
  SF_QUEUE_PUSH_BEARER: {
    label: "Queue push bearer token",
    hint: "Verifies queue pushes from the Salesforce Flow (Authorization: Bearer). Must equal the Token parameter of the External Credential.",
  },
};

export type SettingGroupId = "email" | "sms" | "slack" | "turnstile" | "salesforce";

export type SettingGroup = { id: SettingGroupId; title: string; description: string; keys: readonly ManagedKey[] };

export const SETTING_GROUPS: readonly SettingGroup[] = [
  { id: "email", title: "Email (Resend)", description: "Booking confirmations, reminders and host notices.", keys: ["RESEND_API_KEY", "EMAIL_FROM"] },
  {
    id: "sms",
    title: "Text messages (SendBlue)",
    description: "Merchant and agent text reminders, and STOP / START replies.",
    keys: ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"],
  },
  { id: "slack", title: "Slack", description: "Channel and user group sync, admin notices and agent reminder messages.", keys: ["SLACK_BOT_TOKEN", "SLACK_ADMIN_NOTIFY_CHANNEL"] },
  {
    id: "turnstile",
    title: "Bot protection (Turnstile)",
    description: "Cloudflare Turnstile check on the public booking, reschedule and cancel forms. Without both keys the check is skipped.",
    keys: ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"],
  },
  {
    id: "salesforce",
    title: "Salesforce and n8n",
    description: "Shared secrets for requests between the app, n8n and Salesforce. The n8n URLs stay in Vercel.",
    keys: ["N8N_SIGNING_SECRET", "SF_SYNC_SIGNING_SECRET", "SF_QUEUE_PUSH_BEARER"],
  },
];

/** Longest value the panel accepts. */
export const MAX_VALUE_LENGTH = 4096;

// Line breaks and other control characters are never valid in a key, a header or an address.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const baseValue = z
  .string({ message: "Enter a value." })
  .trim()
  .min(1, "Enter a value.")
  .max(MAX_VALUE_LENGTH, `Use at most ${MAX_VALUE_LENGTH} characters.`)
  .refine((v) => !CONTROL_CHARS.test(v), "Remove line breaks and other control characters.");

export type ParsedValue = { ok: true; value: string } | { ok: false; error: string };

/**
 * Cloudflare's documented Turnstile test keys, such as the secret 1x0000000000000000000000000000000AA
 * that accepts every token. Real site and secret keys start with "0x".
 */
const TURNSTILE_TEST_KEY = /^[1-3]x0+[A-F]{2}$/;

export const TURNSTILE_TEST_KEY_MESSAGE =
  "This is a Cloudflare Turnstile test key. Test keys either let every request pass or block every booking, so they are not accepted in production. Use the keys of your Turnstile widget.";

/**
 * Validates a submitted value: trimmed, not empty, at most MAX_VALUE_LENGTH characters, no
 * control characters, and accepted by the same rule env.ts applies to the variable. In
 * production, Cloudflare's Turnstile test keys are refused as well.
 */
export function parseSettingValue(key: ManagedKey, raw: unknown, opts: { production?: boolean } = {}): ParsedValue {
  const base = baseValue.safeParse(raw);
  if (!base.success) return { ok: false, error: base.error.issues[0]?.message ?? "Enter a value." };
  const rule = integrationValueRules[key].safeParse(base.data);
  if (!rule.success) return { ok: false, error: KEY_INFO[key].invalid ?? "This value is not valid." };
  const production = opts.production ?? process.env.NODE_ENV === "production";
  if (production && (key === "TURNSTILE_SECRET_KEY" || key === "TURNSTILE_SITE_KEY") && TURNSTILE_TEST_KEY.test(base.data)) {
    return { ok: false, error: TURNSTILE_TEST_KEY_MESSAGE };
  }
  return { ok: true, value: base.data };
}

/**
 * Bootstrap variables that stay in the Vercel environment and are never editable in the app.
 * The page shows only whether each one is set.
 */
export const BOOTSTRAP_KEYS: readonly { name: string; required: boolean }[] = [
  { name: "DATABASE_URL", required: true },
  { name: "TOKEN_ENCRYPTION_KEYS", required: true },
  { name: "TOKEN_ENCRYPTION_ACTIVE_KID", required: true },
  { name: "ENTRA_TENANT_ID", required: true },
  { name: "ENTRA_CLIENT_ID", required: true },
  { name: "ENTRA_CLIENT_SECRET", required: true },
  { name: "CRON_SECRET", required: true },
  { name: "IP_HASH_SALT", required: true },
  { name: "APP_BASE_URL", required: true },
  { name: "MCP_BASE_URL", required: false },
  { name: "ADMIN_EMAILS", required: false },
  { name: "ALLOWED_EMAIL_DOMAINS", required: false },
  { name: "N8N_BASE_URL", required: false },
  { name: "N8N_LEAD_WEBHOOK_PATH", required: false },
];

/** Whether each bootstrap variable has a non-empty value. Never returns values. */
export function bootstrapStatus(source: Record<string, string | undefined> = process.env): { name: string; required: boolean; set: boolean }[] {
  return BOOTSTRAP_KEYS.map((k) => ({ ...k, set: typeof source[k.name] === "string" && source[k.name]!.trim() !== "" }));
}
