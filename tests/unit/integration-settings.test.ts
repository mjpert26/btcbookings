import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/server/crypto/aes";
import {
  BOOTSTRAP_KEYS,
  bootstrapStatus,
  isManagedKey,
  isSecretKey,
  KEY_INFO,
  last4,
  LAST4_MIN_LENGTH,
  MANAGED_KEYS,
  MAX_VALUE_LENGTH,
  parseSettingValue,
  PLAIN_KEYS,
  SECRET_KEYS,
  SETTING_GROUPS,
  settingAad,
  TURNSTILE_TEST_KEY_MESSAGE,
} from "@/server/settings/keys";

const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261112120000_integration_settings.sql"), "utf8");

/** The quoted key names inside the first `check (... in (...))` list that follows `marker`. */
function quotedListAfter(marker: string): string[] {
  const start = MIGRATION.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const open = MIGRATION.indexOf("in (", start);
  const close = MIGRATION.indexOf(")", open);
  return [...MIGRATION.slice(open, close).matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
}

describe("integration settings catalog", () => {
  it("manages exactly the agreed keys, split into secret and plain", () => {
    expect([...SECRET_KEYS].sort()).toEqual(
      [
        "RESEND_API_KEY",
        "SENDBLUE_API_KEY",
        "SENDBLUE_API_SECRET",
        "SENDBLUE_WEBHOOK_SECRET",
        "SLACK_BOT_TOKEN",
        "TURNSTILE_SECRET_KEY",
        "N8N_SIGNING_SECRET",
        "SF_SYNC_SIGNING_SECRET",
        "SF_QUEUE_PUSH_BEARER",
      ].sort(),
    );
    expect([...PLAIN_KEYS].sort()).toEqual(["EMAIL_FROM", "SENDBLUE_FROM_NUMBER", "SLACK_ADMIN_NOTIFY_CHANNEL", "TURNSTILE_SITE_KEY"].sort());
    for (const k of SECRET_KEYS) expect(isSecretKey(k)).toBe(true);
    for (const k of PLAIN_KEYS) expect(isSecretKey(k)).toBe(false);
  });

  it("never manages bootstrap secrets or the URLs the app sends signed requests to", () => {
    for (const name of ["DATABASE_URL", "TOKEN_ENCRYPTION_KEYS", "TOKEN_ENCRYPTION_ACTIVE_KID", "ENTRA_CLIENT_SECRET", "CRON_SECRET", "IP_HASH_SALT", "APP_BASE_URL", "MCP_BASE_URL", "ADMIN_EMAILS", "ALLOWED_EMAIL_DOMAINS", "N8N_BASE_URL", "N8N_LEAD_WEBHOOK_PATH"]) {
      expect(isManagedKey(name)).toBe(false);
    }
    const managed = new Set<string>(MANAGED_KEYS);
    expect(BOOTSTRAP_KEYS.filter((b) => managed.has(b.name))).toEqual([]);
  });

  it("matches the check constraints of the migration", () => {
    expect(quotedListAfter("key text primary key").sort()).toEqual([...MANAGED_KEYS].sort());
    expect(quotedListAfter("integration_settings_secret_kind_check").sort()).toEqual([...SECRET_KEYS].sort());
  });

  it("puts every key in exactly one group and describes every key", () => {
    const grouped = SETTING_GROUPS.flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual([...MANAGED_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const k of MANAGED_KEYS) expect(KEY_INFO[k].label.length).toBeGreaterThan(0);
    expect(SETTING_GROUPS.map((g) => g.title)).toEqual(["Email (Resend)", "Text messages (SendBlue)", "Slack", "Bot protection (Turnstile)", "Salesforce and n8n"]);
  });
});

describe("parseSettingValue", () => {
  it("trims and accepts valid values", () => {
    expect(parseSettingValue("SLACK_BOT_TOKEN", "  xoxb-123  ")).toEqual({ ok: true, value: "xoxb-123" });
    expect(parseSettingValue("SENDBLUE_FROM_NUMBER", "+15551234567")).toEqual({ ok: true, value: "+15551234567" });
    expect(parseSettingValue("EMAIL_FROM", "BTC <scheduling@bigthinkcapital.com>")).toEqual({ ok: true, value: "BTC <scheduling@bigthinkcapital.com>" });
    expect(parseSettingValue("SENDBLUE_WEBHOOK_SECRET", "a".repeat(16))).toMatchObject({ ok: true });
  });

  it("rejects empty, too long and multi-line values", () => {
    expect(parseSettingValue("RESEND_API_KEY", "")).toEqual({ ok: false, error: "Enter a value." });
    expect(parseSettingValue("RESEND_API_KEY", "   ")).toEqual({ ok: false, error: "Enter a value." });
    expect(parseSettingValue("RESEND_API_KEY", undefined)).toMatchObject({ ok: false });
    expect(parseSettingValue("RESEND_API_KEY", 42)).toMatchObject({ ok: false });
    expect(parseSettingValue("RESEND_API_KEY", "x".repeat(MAX_VALUE_LENGTH))).toMatchObject({ ok: true });
    expect(parseSettingValue("RESEND_API_KEY", "x".repeat(MAX_VALUE_LENGTH + 1))).toMatchObject({ ok: false, error: expect.stringContaining("4096") });
    expect(parseSettingValue("SLACK_BOT_TOKEN", "xoxb-1\nX-Injected: 1")).toMatchObject({ ok: false, error: expect.stringContaining("line breaks") });
    expect(parseSettingValue("EMAIL_FROM", "a\u0000b")).toMatchObject({ ok: false });
  });

  it("applies the same rule env.ts uses for the variable", () => {
    expect(parseSettingValue("SENDBLUE_FROM_NUMBER", "5551234567")).toEqual({
      ok: false,
      error: "Use E.164 format: a plus sign and 8 to 15 digits, for example +15551234567.",
    });
    expect(parseSettingValue("SENDBLUE_FROM_NUMBER", "+0555123456")).toMatchObject({ ok: false });
    expect(parseSettingValue("SENDBLUE_FROM_NUMBER", "+1 555 123 4567")).toMatchObject({ ok: false });
    expect(parseSettingValue("SENDBLUE_WEBHOOK_SECRET", "short-secret")).toEqual({ ok: false, error: "Use at least 16 characters." });
  });

  it("refuses Cloudflare's Turnstile test keys in production only", () => {
    const testKeys: [("TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY"), string][] = [
      ["TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA"],
      ["TURNSTILE_SECRET_KEY", "2x0000000000000000000000000000000AA"],
      ["TURNSTILE_SECRET_KEY", "3x0000000000000000000000000000000AA"],
      ["TURNSTILE_SITE_KEY", "1x00000000000000000000AA"],
      ["TURNSTILE_SITE_KEY", "2x00000000000000000000AB"],
      ["TURNSTILE_SITE_KEY", "1x00000000000000000000BB"],
      ["TURNSTILE_SITE_KEY", "3x00000000000000000000FF"],
    ];
    for (const [key, value] of testKeys) {
      expect(parseSettingValue(key, value, { production: true })).toEqual({ ok: false, error: TURNSTILE_TEST_KEY_MESSAGE });
      expect(parseSettingValue(key, value, { production: false })).toEqual({ ok: true, value });
    }
    // Real keys start with 0x.
    expect(parseSettingValue("TURNSTILE_SECRET_KEY", "0x4AAAAAAABkMYinukE8nzYS_7Ca4oZYTlS", { production: true })).toMatchObject({ ok: true });
    expect(parseSettingValue("TURNSTILE_SITE_KEY", "0x4AAAAAAABkMYinukE8nzY", { production: true })).toMatchObject({ ok: true });
    // Other keys are not affected.
    expect(parseSettingValue("N8N_SIGNING_SECRET", "1x0000000000000000000000000000000AA", { production: true })).toMatchObject({ ok: true });
  });
});

describe("secret storage helpers", () => {
  it("binds a stored secret to its key name", () => {
    const enc = encryptSecret("xoxb-panel-token", settingAad("SLACK_BOT_TOKEN"));
    expect(decryptSecret(enc, settingAad("SLACK_BOT_TOKEN"))).toBe("xoxb-panel-token");
    // The same ciphertext copied to another key's row does not decrypt.
    expect(() => decryptSecret(enc, settingAad("RESEND_API_KEY"))).toThrow();
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("keeps only the last four characters for display, and none of a short secret", () => {
    expect(LAST4_MIN_LENGTH).toBe(16);
    expect(last4("re_abcdefghi_1234")).toBe("1234");
    expect(last4("x".repeat(12) + "WXYZ")).toBe("WXYZ");
    expect(last4("x".repeat(11) + "WXYZ")).toBeNull();
    expect(last4("shortK3y")).toBeNull();
    expect(last4("abcd")).toBeNull();
    expect(last4("abc")).toBeNull();
  });

  it("reports whether bootstrap variables are set, never their values", () => {
    const status = bootstrapStatus({ DATABASE_URL: "postgres://user:pw@host/db", CRON_SECRET: "  ", APP_BASE_URL: "https://x" });
    expect(status.find((s) => s.name === "DATABASE_URL")).toEqual({ name: "DATABASE_URL", required: true, set: true });
    expect(status.find((s) => s.name === "CRON_SECRET")?.set).toBe(false);
    expect(status.find((s) => s.name === "MCP_BASE_URL")).toEqual({ name: "MCP_BASE_URL", required: false, set: false });
    expect(JSON.stringify(status)).not.toContain("postgres://");
  });
});
