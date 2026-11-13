import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { setServiceClient, withUser, type Sql } from "@/server/db/client";
import type { SessionUser } from "@/server/auth/session";
import { DEFAULT_EMAIL_FROM, resetEnvCache } from "@/server/env";
import { encryptSecret, encryptWith, parseKeyRing } from "@/server/crypto/aes";
import { sendEmail, type ResendLike } from "@/server/email/send";
import { verifyTurnstile } from "@/server/http/turnstile";
import { sendSms } from "@/server/sms/send";
import { slackClientFromSettings, SlackNotConfiguredError } from "@/server/slack/client";
import { checkPushBearer } from "@/server/sync/http";
import {
  CACHE_TTL_MS,
  IntegrationSettingUnavailableError,
  integrationSettings,
  invalidateIntegrationSettings,
  READ_LIMITS,
  resetIntegrationSettingsCache,
} from "@/server/settings/integrations";
import { listIntegrationSettings, removeIntegrationSetting, setIntegrationSetting, SettingsError, type SettingView } from "@/server/settings/admin";
import { runSettingsCheck, TEST_SMS_TEXT, TEST_SMS_TEXT_TWILIO, TURNSTILE_DUMMY_TOKEN } from "@/server/settings/checks";
import { MANAGED_KEYS, settingAad } from "@/server/settings/keys";

let sql: Sql;

beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  resetIntegrationSettingsCache();
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  resetIntegrationSettingsCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
  resetIntegrationSettingsCache();
});

function session(u: { id: string; email: string }, role: SessionUser["role"]): SessionUser {
  return { id: u.id, email: u.email, name: "Admin", slug: u.id, role, timezone: "America/New_York", languages: ["en"], photoUrl: null, calendarStatus: null };
}

async function adminSession(): Promise<SessionUser> {
  const u = await makeUser(sql, { role: "admin", name: "Ada Admin" });
  return session(u, "admin");
}

/** A service client whose every query and transaction fails like a refused connection. */
function refusingClient(): Sql {
  const refuse = () =>
    Promise.reject(Object.assign(new Error("connect ECONNREFUSED postgres://app:hunter2@db.internal/app"), { code: "ECONNREFUSED" }));
  return Object.assign(refuse, { begin: refuse }) as unknown as Sql;
}

/** A service client whose queries and transactions never finish. */
function hangingClient(): Sql {
  const hang = () => new Promise(() => {});
  return Object.assign(hang, { begin: hang }) as unknown as Sql;
}

async function viewsByKey(user: SessionUser): Promise<Record<string, SettingView>> {
  return Object.fromEntries((await listIntegrationSettings(user)).map((v) => [v.key, v]));
}

const EMAIL = { to: "invitee@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "k-unavailable", tag: "test" };

type Captured = { url: string; init: RequestInit };

/** A fetch replacement that records each request and answers with `body`. Never touches the network. */
function fakeFetch(body: Record<string, unknown>, status = 200) {
  const calls: Captured[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

function fakeResend() {
  const keys: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const factory = (apiKey: string): ResendLike => {
    keys.push(apiKey);
    return {
      emails: {
        send: (async (payload: Record<string, unknown>) => {
          payloads.push(payload);
          return { data: { id: "em_test" }, error: null, headers: null };
        }) as unknown as ResendLike["emails"]["send"],
      },
    };
  };
  return { factory, keys, payloads };
}

describe("resolver", () => {
  it("uses the environment when nothing is set in the panel", async () => {
    const cfg = await integrationSettings();
    expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-test");
    expect(cfg.N8N_SIGNING_SECRET).toBe("test-n8n-signing-secret");
    expect(cfg.RESEND_API_KEY).toBeUndefined();
    expect(cfg.EMAIL_FROM).toBe(DEFAULT_EMAIL_FROM);
  });

  it("prefers the panel value, and falls back to the environment when it is removed", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-AAAA");
    await setIntegrationSetting(admin, "EMAIL_FROM", "Panel Sender <panel@bigthinkcapital.com>");
    await setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "+15551234567");

    let cfg = await integrationSettings();
    expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-panel-token-AAAA");
    expect(cfg.EMAIL_FROM).toBe("Panel Sender <panel@bigthinkcapital.com>");
    expect(cfg.SENDBLUE_FROM_NUMBER).toBe("+15551234567");
    expect(cfg.N8N_SIGNING_SECRET).toBe("test-n8n-signing-secret");

    // Secrets are stored encrypted; plain keys are stored as text.
    const rows = await sql<{ key: string; value_plain: string | null; value_enc: string | null; last4: string | null }[]>`
      select key, value_plain, value_enc, last4 from app.integration_settings order by key
    `;
    const slack = rows.find((r) => r.key === "SLACK_BOT_TOKEN")!;
    expect(slack.value_plain).toBeNull();
    expect(slack.last4).toBe("AAAA");
    expect(slack.value_enc).toMatch(/^v1\./);
    expect(slack.value_enc).not.toContain("xoxb-panel");
    expect(rows.find((r) => r.key === "EMAIL_FROM")).toMatchObject({ value_plain: "Panel Sender <panel@bigthinkcapital.com>", value_enc: null, last4: null });

    await removeIntegrationSetting(admin, "SLACK_BOT_TOKEN");
    await removeIntegrationSetting(admin, "EMAIL_FROM");
    cfg = await integrationSettings();
    expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-test");
    expect(cfg.EMAIL_FROM).toBe(DEFAULT_EMAIL_FROM);
    expect(cfg.SENDBLUE_FROM_NUMBER).toBe("+15551234567");
  });

  it("reads environment changes on every call; only panel values are cached", async () => {
    expect((await integrationSettings()).RESEND_API_KEY).toBeUndefined();
    vi.stubEnv("RESEND_API_KEY", "re_env_value_1111");
    resetEnvCache();
    expect((await integrationSettings()).RESEND_API_KEY).toBe("re_env_value_1111");
  });

  it("caches panel values for the TTL and drops them on invalidation", async () => {
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-test");
    // A write from another instance: this instance's cache is not invalidated.
    await sql`
      insert into app.integration_settings (key, is_secret, value_enc, last4)
      values ('SLACK_BOT_TOKEN', true, ${encryptSecret("xoxb-other-instance-BBBB", settingAad("SLACK_BOT_TOKEN"))}, 'BBBB')
    `;
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-test");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + CACHE_TTL_MS + 1000);
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-other-instance-BBBB");
    vi.restoreAllMocks();

    await sql`update app.integration_settings set value_enc = ${encryptSecret("xoxb-newer-CCCC", settingAad("SLACK_BOT_TOKEN"))}, last4 = 'CCCC'`;
    invalidateIntegrationSettings();
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-newer-CCCC");
  });

  it("invalidates the cache after a write in the same instance", async () => {
    const admin = await adminSession();
    expect((await integrationSettings()).SF_QUEUE_PUSH_BEARER).toBe("test-sf-queue-push-bearer-token");
    await setIntegrationSetting(admin, "SF_QUEUE_PUSH_BEARER", "panel-bearer-token-DDDD");
    expect((await integrationSettings()).SF_QUEUE_PUSH_BEARER).toBe("panel-bearer-token-DDDD");
    await removeIntegrationSetting(admin, "SF_QUEUE_PUSH_BEARER");
    expect((await integrationSettings()).SF_QUEUE_PUSH_BEARER).toBe("test-sf-queue-push-bearer-token");
  });

  it("falls back to the environment when no read has succeeded yet, and logs no values", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-EEEE");
    resetIntegrationSettingsCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setServiceClient(refusingClient());
    try {
      const cfg = await integrationSettings();
      expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-test");
      expect(cfg.N8N_SIGNING_SECRET).toBe("test-n8n-signing-secret");
      // Every key may be set in the panel, so none of them counts as deliberately not set.
      expect([...cfg.unavailable].sort()).toEqual([...MANAGED_KEYS].sort());
    } finally {
      setServiceClient(sql);
    }
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).toContain("using environment values");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("xoxb-");
  });

  it("keeps using the last values read when a later read fails", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-STALE-OK");
    await setIntegrationSetting(admin, "TURNSTILE_SECRET_KEY", "0x-panel-turnstile-secret-STAL");
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-STALE-OK");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setServiceClient(refusingClient());
    try {
      // A failed fresh read (a test button) neither loses the values nor drops the cache.
      expect((await integrationSettings({ fresh: true })).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-STALE-OK");
      // A failed refresh after the TTL serves the last values read, not the environment.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + CACHE_TTL_MS + 1000);
      const cfg = await integrationSettings();
      expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-panel-token-STALE-OK");
      expect(cfg.TURNSTILE_SECRET_KEY).toBe("0x-panel-turnstile-secret-STAL");
      expect(cfg.unavailable).toEqual([]);
      // Bot protection stays on.
      expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: false, reason: "missing_token" });
      // A write in this instance invalidates the cache but keeps the last values as the fallback.
      invalidateIntegrationSettings();
      expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-STALE-OK");
    } finally {
      setServiceClient(sql);
    }
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("using the last values read");
    expect(logged).not.toContain("xoxb-");
  });

  it("does not wait for a read that does not finish in time", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-SLOW-OK");
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-SLOW-OK");
    invalidateIntegrationSettings();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setServiceClient(hangingClient());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = integrationSettings();
      await vi.advanceTimersByTimeAsync(READ_LIMITS.overallMs + 10);
      expect((await pending).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-SLOW-OK");
    } finally {
      vi.useRealTimers();
      setServiceClient(sql);
    }
    expect(warn.mock.calls.flat().join(" ")).toContain("settings_read_timeout");
  });

  it("does not wait behind a lock on the settings table", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-LOCK-OK");
    expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-LOCK-OK");
    invalidateIntegrationSettings();

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => (markLocked = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`lock table app.integration_settings in access exclusive mode`;
      markLocked();
      await released;
    });
    await locked;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    try {
      expect((await integrationSettings()).SLACK_BOT_TOKEN).toBe("xoxb-panel-token-LOCK-OK");
      expect(Date.now() - started).toBeLessThan(READ_LIMITS.overallMs + 1000);
    } finally {
      release();
      await holder;
    }
    // 55P03: lock_not_available, from lock_timeout.
    expect(warn.mock.calls.flat().join(" ")).toContain("55P03");
  });

  it("does not fall back to SendBlue while the Twilio Account SID cannot be read", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "TWILIO_ACCOUNT_SID", "AC" + "0123456789abcdef".repeat(2));
    vi.stubEnv("SENDBLUE_API_KEY", "sb-env-key-id");
    vi.stubEnv("SENDBLUE_API_SECRET", "sb-env-secret-key");
    vi.stubEnv("SENDBLUE_FROM_NUMBER", "+12125550100");
    resetEnvCache();
    // No earlier good read, so the panel is unknown.
    resetIntegrationSettingsCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const http = fakeFetch({ status: "QUEUED", message_handle: "mh_1" });
    vi.stubGlobal("fetch", http.fn);
    setServiceClient(refusingClient());
    try {
      await expect(sendSms({ to: "+12125550199", content: "Hi" }, "test")).rejects.toMatchObject({
        name: "IntegrationSettingUnavailableError",
        key: "TWILIO_ACCOUNT_SID",
      });
      expect(http.calls).toHaveLength(0);
    } finally {
      setServiceClient(sql);
      vi.unstubAllGlobals();
    }
  });

  it("does not let a missing key look deliberately unset while the settings cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    resetEnvCache();
    const resend = fakeResend();
    setServiceClient(refusingClient());
    try {
      // Jobs fail and are retried instead of finishing without sending.
      await expect(sendEmail(EMAIL, { resend: resend.factory })).rejects.toBeInstanceOf(IntegrationSettingUnavailableError);
      await expect(sendSms({ to: "+12125550199", content: "Hi" }, "test")).rejects.toBeInstanceOf(IntegrationSettingUnavailableError);
      await expect(slackClientFromSettings()).rejects.toBeInstanceOf(IntegrationSettingUnavailableError);
      // Bot protection fails closed, as it does when Cloudflare cannot be reached.
      expect(await verifyTurnstile("token-1", { action: "book" })).toEqual({ ok: false, reason: "settings_unavailable" });
    } finally {
      setServiceClient(sql);
    }
    expect(resend.keys).toEqual([]);

    // Once the settings can be read, a key set nowhere is simply not configured, as before.
    resetIntegrationSettingsCache();
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await sendEmail(EMAIL, { resend: resend.factory })).toEqual({ id: null, skipped: true });
    await expect(slackClientFromSettings()).rejects.toBeInstanceOf(SlackNotConfiguredError);
    expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: true });
  });

  it("does not decrypt a secret copied to another key's row", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-FFFF");
    const [{ value_enc }] = await sql<{ value_enc: string }[]>`select value_enc from app.integration_settings where key = 'SLACK_BOT_TOKEN'`;
    await sql`insert into app.integration_settings (key, is_secret, value_enc, last4) values ('RESEND_API_KEY', true, ${value_enc}, 'FFFF')`;
    resetIntegrationSettingsCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = await integrationSettings();
    expect(cfg.RESEND_API_KEY).toBeUndefined();
    expect(cfg.unavailable).toEqual(["RESEND_API_KEY"]);
    expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-panel-token-FFFF");
    expect(warn.mock.calls.flat().join(" ")).toContain("RESEND_API_KEY");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("xoxb-panel");
  });
});

describe("row-level security and grants", () => {
  it("hides the table from agents and keeps the ciphertext unreadable for admins", async () => {
    const admin = await adminSession();
    const agent = await makeUser(sql, { role: "user" });
    const manager = await makeUser(sql, { role: "manager" });
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-GGGG");

    expect(await withUser(agent.id, (tx) => tx`select key, last4 from app.integration_settings`)).toEqual([]);
    expect(await withUser(manager.id, (tx) => tx`select key, last4 from app.integration_settings`)).toEqual([]);
    await expect(withUser(agent.id, (tx) => tx`select value_enc from app.integration_settings`)).rejects.toMatchObject({ code: "42501" });

    const rows = await withUser(admin.id, (tx) => tx`select key, is_secret, value_plain, last4, updated_by, updated_at from app.integration_settings`);
    expect(rows).toEqual([expect.objectContaining({ key: "SLACK_BOT_TOKEN", is_secret: true, value_plain: null, last4: "GGGG", updated_by: admin.id })]);
    await expect(withUser(admin.id, (tx) => tx`select value_enc from app.integration_settings`)).rejects.toMatchObject({ code: "42501" });
    await expect(withUser(admin.id, (tx) => tx`select * from app.integration_settings`)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses writes from anyone but an admin acting as themselves", async () => {
    const admin = await adminSession();
    const agent = await makeUser(sql, { role: "user" });
    await setIntegrationSetting(admin, "EMAIL_FROM", "Panel Sender <panel@bigthinkcapital.com>");

    await expect(
      withUser(agent.id, (tx) => tx`insert into app.integration_settings (key, is_secret, value_plain, updated_by) values ('SLACK_ADMIN_NOTIFY_CHANNEL', false, 'C0123456789', ${agent.id})`),
    ).rejects.toThrow(/row-level security/);
    const updated = await withUser(agent.id, (tx) => tx`update app.integration_settings set value_plain = 'Evil <evil@example.com>', updated_by = ${agent.id} where key = 'EMAIL_FROM'`);
    expect(updated.count).toBe(0);
    const deleted = await withUser(agent.id, (tx) => tx`delete from app.integration_settings`);
    expect(deleted.count).toBe(0);
    const [row] = await sql`select value_plain from app.integration_settings where key = 'EMAIL_FROM'`;
    expect(row.value_plain).toBe("Panel Sender <panel@bigthinkcapital.com>");

    // An admin cannot attribute a write to someone else.
    await expect(
      withUser(admin.id, (tx) => tx`insert into app.integration_settings (key, is_secret, value_plain, updated_by) values ('SLACK_ADMIN_NOTIFY_CHANNEL', false, 'C0123456789', ${agent.id})`),
    ).rejects.toThrow(/row-level security/);

    await expect(setIntegrationSetting(session(agent, "user"), "EMAIL_FROM", "Agent <agent@bigthinkcapital.com>")).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeIntegrationSetting(session(agent, "manager"), "EMAIL_FROM")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listIntegrationSettings(session(agent, "user"))).rejects.toBeInstanceOf(SettingsError);
  });

  it("enforces the key list and the value columns in the database", async () => {
    await expect(sql`insert into app.integration_settings (key, is_secret, value_plain) values ('DATABASE_URL', false, 'postgres://x')`).rejects.toThrow(/check constraint/);
    await expect(sql`insert into app.integration_settings (key, is_secret, value_plain) values ('N8N_BASE_URL', false, 'https://evil.example.com')`).rejects.toThrow(/check constraint/);
    await expect(sql`insert into app.integration_settings (key, is_secret, value_plain) values ('RESEND_API_KEY', false, 're_plain')`).rejects.toThrow(/check constraint/);
    await expect(sql`insert into app.integration_settings (key, is_secret, value_plain, value_enc, last4) values ('SLACK_BOT_TOKEN', true, 'xoxb', 'v1.x', 'xoxb')`).rejects.toThrow(/check constraint/);
    await expect(sql`insert into app.integration_settings (key, is_secret, value_enc, last4) values ('EMAIL_FROM', true, 'v1.x', 'abcd')`).rejects.toThrow(/check constraint/);
  });
});

describe("admin functions", () => {
  it("validates values with the environment rules and never stores bootstrap keys", async () => {
    const admin = await adminSession();
    await expect(setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "5551234567")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("E.164") });
    await expect(setIntegrationSetting(admin, "SENDBLUE_WEBHOOK_SECRET", "too-short")).rejects.toMatchObject({ code: "invalid" });
    await expect(setIntegrationSetting(admin, "RESEND_API_KEY", "   ")).rejects.toMatchObject({ code: "invalid" });
    await expect(setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-1\r\nX: y")).rejects.toMatchObject({ code: "invalid" });
    await expect(setIntegrationSetting(admin, "DATABASE_URL", "postgres://evil")).rejects.toMatchObject({ code: "unknown_key" });
    await expect(setIntegrationSetting(admin, "N8N_BASE_URL", "https://evil.example.com")).rejects.toMatchObject({ code: "unknown_key" });
    await expect(removeIntegrationSetting(admin, "RESEND_API_KEY")).rejects.toMatchObject({ code: "not_set" });
    expect(await sql`select key from app.integration_settings`).toHaveLength(0);
    expect(await sql`select id from app.audit_log`).toHaveLength(0);
  });

  it("lists every key with its source, last4 for secrets and the full value for plain keys", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-HHHH");
    await setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "+15551234567");
    const views = Object.fromEntries((await listIntegrationSettings(admin)).map((v) => [v.key, v]));
    expect(Object.keys(views)).toHaveLength(MANAGED_KEYS.length);
    expect(views.SLACK_BOT_TOKEN).toMatchObject({ source: "panel", isSecret: true, last4: "HHHH", value: null, updatedByName: "Ada Admin" });
    expect(views.SLACK_BOT_TOKEN.updatedAt).toBeInstanceOf(Date);
    expect(views.N8N_SIGNING_SECRET).toMatchObject({ source: "vercel", last4: "cret", value: null, updatedAt: null });
    expect(views.RESEND_API_KEY).toMatchObject({ source: "unset", last4: null, value: null });
    expect(views.EMAIL_FROM).toMatchObject({ source: "default", isSecret: false, value: DEFAULT_EMAIL_FROM });
    expect(views.SENDBLUE_FROM_NUMBER).toMatchObject({ source: "panel", value: "+15551234567", last4: null });
    const text = JSON.stringify(views);
    expect(text).not.toContain("xoxb-panel-token");
    expect(text).not.toContain("test-n8n-signing-secret");
    expect(text).not.toContain("test-sf-queue-push-bearer-token");
  });

  it("audits every change with only the key, source and last four characters", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-secret-AAAA");
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-secret-BBBB");
    await removeIntegrationSetting(admin, "SLACK_BOT_TOKEN");
    await setIntegrationSetting(admin, "EMAIL_FROM", "Panel Sender <panel@bigthinkcapital.com>");

    const rows = await sql<{ action: string; entity_type: string; entity_id: string; actor_user_id: string; before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select action, entity_type, entity_id, actor_user_id, before, after from app.audit_log order by created_at, id
    `;
    // The Vercel token "xoxb-test" is shorter than 16 characters, so none of it is recorded.
    expect(rows.map((r) => [r.action, r.entity_type, r.entity_id])).toEqual([
      ["settings.update", "integration_setting", "SLACK_BOT_TOKEN"],
      ["settings.update", "integration_setting", "SLACK_BOT_TOKEN"],
      ["settings.remove", "integration_setting", "SLACK_BOT_TOKEN"],
      ["settings.update", "integration_setting", "EMAIL_FROM"],
    ]);
    expect(rows.every((r) => r.actor_user_id === admin.id)).toBe(true);
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [
        { key: "SLACK_BOT_TOKEN", source: "vercel", last4: null },
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "AAAA" },
      ],
      [
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "AAAA" },
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "BBBB" },
      ],
      [
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "BBBB" },
        { key: "SLACK_BOT_TOKEN", source: "vercel", last4: null },
      ],
      [
        { key: "EMAIL_FROM", source: "default", last4: null },
        { key: "EMAIL_FROM", source: "panel", last4: null },
      ],
    ]);
    const all = JSON.stringify(await sql`select * from app.audit_log`);
    expect(all).not.toContain("xoxb-panel-secret");
    expect(all).not.toContain("xoxb-test");
    expect(all).not.toContain("panel@bigthinkcapital.com");
  });
});

describe("secrets the app cannot show or use", () => {
  it("never stores, shows or audits the last characters of a short secret", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SF_QUEUE_PUSH_BEARER", "shortK3y");
    const [row] = await sql<{ last4: string | null; value_enc: string }[]>`select last4, value_enc from app.integration_settings where key = 'SF_QUEUE_PUSH_BEARER'`;
    expect(row.last4).toBeNull();
    expect(row.value_enc).toMatch(/^v1\./);
    expect((await integrationSettings()).SF_QUEUE_PUSH_BEARER).toBe("shortK3y");

    vi.stubEnv("N8N_SIGNING_SECRET", "n8n-shrt");
    resetEnvCache();
    const views = await viewsByKey(admin);
    expect(views.SF_QUEUE_PUSH_BEARER).toMatchObject({ source: "panel", last4: null, value: null });
    expect(views.N8N_SIGNING_SECRET).toMatchObject({ source: "vercel", last4: null, value: null });

    await setIntegrationSetting(admin, "N8N_SIGNING_SECRET", "n8n-signing-secret-long-ABCD");
    await removeIntegrationSetting(admin, "SF_QUEUE_PUSH_BEARER");
    const audit = await sql<{ entity_id: string; before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select entity_id, before, after from app.audit_log order by created_at, id
    `;
    expect(audit.map((r) => [r.entity_id, r.before, r.after])).toEqual([
      ["SF_QUEUE_PUSH_BEARER", { key: "SF_QUEUE_PUSH_BEARER", source: "vercel", last4: "oken" }, { key: "SF_QUEUE_PUSH_BEARER", source: "panel", last4: null }],
      ["N8N_SIGNING_SECRET", { key: "N8N_SIGNING_SECRET", source: "vercel", last4: null }, { key: "N8N_SIGNING_SECRET", source: "panel", last4: "ABCD" }],
      ["SF_QUEUE_PUSH_BEARER", { key: "SF_QUEUE_PUSH_BEARER", source: "panel", last4: null }, { key: "SF_QUEUE_PUSH_BEARER", source: "vercel", last4: "oken" }],
    ]);
    const stored = JSON.stringify([audit, await sql`select key, last4 from app.integration_settings`, views]);
    expect(stored).not.toContain("K3y");
    expect(stored).not.toContain("shrt");
  });

  it("flags a saved secret that does not decrypt, and does not treat the key as not set", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "TURNSTILE_SITE_KEY", "0x-panel-site-key");
    // Encrypted with a key id that is no longer in TOKEN_ENCRYPTION_KEYS.
    const removedRing = parseKeyRing(`k9:${Buffer.alloc(32, 9).toString("base64")}`, "k9");
    await sql`
      insert into app.integration_settings (key, is_secret, value_enc, last4, updated_by)
      values ('TURNSTILE_SECRET_KEY', true, ${encryptWith(removedRing, "0x-panel-turnstile-secret-WXYZ", settingAad("TURNSTILE_SECRET_KEY"))}, 'WXYZ', ${admin.id}),
             ('RESEND_API_KEY', true, ${encryptSecret("re_panel_key_for_slack_9876", settingAad("SLACK_BOT_TOKEN"))}, '9876', ${admin.id})
    `;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let views = await viewsByKey(admin);
    expect(views.TURNSTILE_SECRET_KEY).toMatchObject({ source: "panel", effectiveSource: "unset", problem: "undecryptable", last4: "WXYZ" });
    expect(views.RESEND_API_KEY).toMatchObject({ source: "panel", effectiveSource: "unset", problem: "undecryptable" });
    expect(views.TURNSTILE_SITE_KEY).toMatchObject({ source: "panel", effectiveSource: "panel", problem: null });
    expect(views.SLACK_BOT_TOKEN).toMatchObject({ source: "vercel", effectiveSource: "vercel", problem: null });
    expect(JSON.stringify(views)).not.toContain("0x-panel-turnstile-secret");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("0x-panel-turnstile-secret");

    const cfg = await integrationSettings();
    expect([...cfg.unavailable].sort()).toEqual(["RESEND_API_KEY", "TURNSTILE_SECRET_KEY"]);
    expect(cfg.TURNSTILE_SECRET_KEY).toBeUndefined();
    // Bot protection fails closed and email jobs are retried instead of finishing unsent.
    expect(await verifyTurnstile("token-1", { action: "book" })).toEqual({ ok: false, reason: "settings_unavailable" });
    const resend = fakeResend();
    await expect(sendEmail(EMAIL, { resend: resend.factory })).rejects.toBeInstanceOf(IntegrationSettingUnavailableError);
    expect(await runSettingsCheck(admin, "turnstile")).toMatchObject({ ok: false, message: expect.stringContaining("no longer decrypts") });

    // With a Vercel value, the app uses it, and the page says so.
    vi.stubEnv("RESEND_API_KEY", "re_vercel_key_value_5678");
    resetEnvCache();
    views = await viewsByKey(admin);
    expect(views.RESEND_API_KEY).toMatchObject({ source: "panel", effectiveSource: "vercel", problem: "undecryptable" });
    expect(await sendEmail(EMAIL, { resend: resend.factory })).toEqual({ id: "em_test", skipped: false });
    expect(resend.keys).toEqual(["re_vercel_key_value_5678"]);

    // Saving the value again fixes it.
    await setIntegrationSetting(admin, "TURNSTILE_SECRET_KEY", "0x-panel-turnstile-secret-NEW1");
    views = await viewsByKey(admin);
    expect(views.TURNSTILE_SECRET_KEY).toMatchObject({ source: "panel", effectiveSource: "panel", problem: null, last4: "NEW1" });
    expect((await integrationSettings()).TURNSTILE_SECRET_KEY).toBe("0x-panel-turnstile-secret-NEW1");
  });
});

describe("consumers use the panel value", () => {
  it("sends email with the panel Resend key and from address", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "RESEND_API_KEY", "re_panel_key_1234");
    await setIntegrationSetting(admin, "EMAIL_FROM", "Panel Sender <panel@bigthinkcapital.com>");
    const resend = fakeResend();
    const result = await sendEmail(
      { to: "invitee@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "k1", tag: "test" },
      { resend: resend.factory },
    );
    expect(result).toEqual({ id: "em_test", skipped: false });
    expect(resend.keys).toEqual(["re_panel_key_1234"]);
    expect(resend.payloads[0]).toMatchObject({ from: "Panel Sender <panel@bigthinkcapital.com>", to: "invitee@example.com" });

    // Without a key anywhere, the email is logged and skipped as before.
    await removeIntegrationSetting(admin, "RESEND_API_KEY");
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await sendEmail({ to: "invitee@example.com", subject: "Hi", html: "", text: "", idempotencyKey: "k2", tag: "test" }, { resend: resend.factory })).toEqual({
      id: null,
      skipped: true,
    });
    expect(resend.keys).toHaveLength(1);
  });

  it("verifies Turnstile tokens with the panel secret", async () => {
    const admin = await adminSession();
    expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: true });
    await setIntegrationSetting(admin, "TURNSTILE_SECRET_KEY", "0x-panel-turnstile-secret");
    expect(await verifyTurnstile(null, { action: "book" })).toEqual({ ok: false, reason: "missing_token" });
    const cf = fakeFetch({ success: true, action: "book", hostname: "localhost" });
    expect(await verifyTurnstile("token-1", { action: "book", remoteIp: "203.0.113.9", fetchImpl: cf.fn as unknown as typeof fetch })).toEqual({ ok: true });
    const body = new URLSearchParams(String(cf.calls[0].init.body));
    expect(body.get("secret")).toBe("0x-panel-turnstile-secret");
    expect(body.get("response")).toBe("token-1");
  });

  it("authenticates queue pushes with the panel bearer token only", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SF_QUEUE_PUSH_BEARER", "panel-bearer-token-0000");
    const req = (token: string) => new Request("http://localhost/api/sync/queue-membership", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(await checkPushBearer(req("panel-bearer-token-0000"))).toEqual({ ok: true });
    const old = await checkPushBearer(req("test-sf-queue-push-bearer-token"));
    expect(old.ok).toBe(false);
  });

  it("texts only from the configured sending number", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SENDBLUE_API_KEY", "sb-panel-key-id");
    await setIntegrationSetting(admin, "SENDBLUE_API_SECRET", "sb-panel-secret-key");
    const sb = fakeFetch({ status: "QUEUED", message_handle: "mh_1" });
    vi.stubGlobal("fetch", sb.fn);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // Without a sending number SendBlue would choose a line, so nothing is sent.
      expect(await sendSms({ to: "+12125550199", content: "Hi" }, "test")).toEqual({ messageHandle: null, status: null, skipped: true });
      expect(sb.calls).toHaveLength(0);
      expect(info.mock.calls.flat().join(" ")).toContain("SENDBLUE_FROM_NUMBER not set");

      await setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "+12125550100");
      expect(await sendSms({ to: "+12125550199", content: "Hi" }, "test")).toMatchObject({ messageHandle: "mh_1", skipped: false });
      expect(JSON.parse(String(sb.calls[0].init.body))).toMatchObject({ number: "+12125550199", from_number: "+12125550100" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends every text through Twilio once the Twilio Account SID is set", async () => {
    const admin = await adminSession();
    const sid = "AC" + "0123456789abcdef".repeat(2);
    await setIntegrationSetting(admin, "SENDBLUE_API_KEY", "sb-panel-key-id");
    await setIntegrationSetting(admin, "SENDBLUE_API_SECRET", "sb-panel-secret-key");
    await setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "+12125550100");
    const http = fakeFetch({ sid: "SM1", status: "queued" }, 201);
    vi.stubGlobal("fetch", http.fn);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await setIntegrationSetting(admin, "TWILIO_ACCOUNT_SID", sid);
      // Twilio is chosen but incomplete: nothing is sent, and SendBlue is not used instead.
      expect(await sendSms({ to: "+12125550199", content: "Hi" }, "test")).toMatchObject({ skipped: true });
      await setIntegrationSetting(admin, "TWILIO_AUTH_TOKEN", "a".repeat(32));
      expect(await sendSms({ to: "+12125550199", content: "Hi" }, "test")).toMatchObject({ skipped: true });
      expect(http.calls).toHaveLength(0);
      expect(info.mock.calls.flat().join(" ")).toContain("TWILIO_FROM_NUMBER not set");

      await setIntegrationSetting(admin, "TWILIO_FROM_NUMBER", "+18885550100");
      expect(await sendSms({ to: "+12125550199", content: "Hi" }, "test")).toEqual({ messageHandle: "SM1", status: "queued", skipped: false });
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
      expect(Object.fromEntries(new URLSearchParams(String(http.calls[0].init.body)))).toEqual({ To: "+12125550199", From: "+18885550100", Body: "Hi" });

      // Removing the Account SID returns to SendBlue.
      await removeIntegrationSetting(admin, "TWILIO_ACCOUNT_SID");
      const sb = fakeFetch({ status: "QUEUED", message_handle: "mh_2" });
      vi.stubGlobal("fetch", sb.fn);
      expect(await sendSms({ to: "+12125550199", content: "Hi" }, "test")).toMatchObject({ messageHandle: "mh_2" });
      expect(sb.calls[0].url).toContain("api.sendblue.com");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds the Slack client from the panel token", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-JJJJ");
    const slack = fakeFetch({ ok: true, team: "BTC", user: "btc_scheduler" });
    await (await slackClientFromSettings(slack.fn)).authTest();
    expect((slack.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-panel-token-JJJJ");
  });
});

describe("test buttons", () => {
  it("sends the test email only to the signed-in admin", async () => {
    const admin = await adminSession();
    expect(await runSettingsCheck(admin, "email")).toMatchObject({ ok: false, message: expect.stringContaining("No Resend API key") });
    await setIntegrationSetting(admin, "RESEND_API_KEY", "re_panel_key_5678");
    const resend = fakeResend();
    const result = await runSettingsCheck(admin, "email", { resend: resend.factory });
    expect(result).toEqual({ ok: true, message: `Test email sent to ${admin.email} from ${DEFAULT_EMAIL_FROM}.` });
    expect(resend.keys).toEqual(["re_panel_key_5678"]);
    expect(resend.payloads).toHaveLength(1);
    expect(resend.payloads[0].to).toBe(admin.email);
  });

  it("checks the Slack token with auth.test and posts nothing", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-KKKK");
    const ok = fakeFetch({ ok: true, team: "BTC", user: "btc_scheduler" });
    expect(await runSettingsCheck(admin, "slack", { fetch: ok.fn })).toEqual({
      ok: true,
      message: "The bot token is valid for workspace BTC (bot user btc_scheduler). Nothing was posted.",
    });
    expect(ok.calls.map((c) => c.url)).toEqual(["https://slack.com/api/auth.test"]);
    expect((ok.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-panel-token-KKKK");

    const bad = fakeFetch({ ok: false, error: "invalid_auth" });
    expect(await runSettingsCheck(admin, "slack", { fetch: bad.fn })).toEqual({ ok: false, message: "Slack rejected the bot token (invalid_auth)." });
  });

  it("checks the Turnstile secret with a dummy token", async () => {
    const admin = await adminSession();
    expect(await runSettingsCheck(admin, "turnstile")).toMatchObject({ ok: false });
    await setIntegrationSetting(admin, "TURNSTILE_SECRET_KEY", "0x-panel-turnstile-secret");

    const valid = fakeFetch({ success: false, "error-codes": ["invalid-input-response"] });
    const good = await runSettingsCheck(admin, "turnstile", { fetch: valid.fn });
    expect(good.ok).toBe(true);
    expect(good.message).toContain("The secret key is valid");
    expect(good.message).toContain("The site key is not set");
    expect(valid.calls[0].url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String(valid.calls[0].init.body));
    expect(body.get("secret")).toBe("0x-panel-turnstile-secret");
    expect(body.get("response")).toBe(TURNSTILE_DUMMY_TOKEN);

    const invalid = fakeFetch({ success: false, "error-codes": ["invalid-input-secret"] });
    expect(await runSettingsCheck(admin, "turnstile", { fetch: invalid.fn })).toMatchObject({ ok: false, message: expect.stringContaining("invalid-input-secret") });

    // A secret that accepts a made-up token is Cloudflare's always-pass test key: bot protection is off.
    const alwaysPass = fakeFetch({ success: true, "error-codes": [] });
    expect(await runSettingsCheck(admin, "turnstile", { fetch: alwaysPass.fn })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Cloudflare test secret key"),
    });
    // "Token already spent" for a token that was never issued is not a real secret's answer either.
    const spent = fakeFetch({ success: false, "error-codes": ["timeout-or-duplicate"] });
    expect(await runSettingsCheck(admin, "turnstile", { fetch: spent.fn })).toMatchObject({ ok: false });

    await setIntegrationSetting(admin, "TURNSTILE_SITE_KEY", "0x-panel-site-key");
    const both = await runSettingsCheck(admin, "turnstile", { fetch: valid.fn });
    expect(both.message).not.toContain("The site key is not set");
  });

  it("sends the test text only to the admin's own number, with the panel credentials", async () => {
    const admin = await adminSession();
    expect(await runSettingsCheck(admin, "sms")).toMatchObject({ ok: false, message: expect.stringContaining("API key ID and secret key") });
    await setIntegrationSetting(admin, "SENDBLUE_API_KEY", "sb-panel-key-id");
    await setIntegrationSetting(admin, "SENDBLUE_API_SECRET", "sb-panel-secret-key");
    const sb = fakeFetch({ status: "QUEUED", message_handle: "mh_1" });
    expect(await runSettingsCheck(admin, "sms", { fetch: sb.fn })).toMatchObject({ ok: false, message: expect.stringContaining("sending number") });
    await setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "+15550001111");

    expect(await runSettingsCheck(admin, "sms", { fetch: sb.fn })).toMatchObject({ ok: false, message: expect.stringContaining("Availability > Booking preferences") });
    expect(sb.calls).toHaveLength(0);

    await sql`insert into app.user_settings (user_id, sms_phone) values (${admin.id}, '+12125550199')`;
    expect(await runSettingsCheck(admin, "sms", { fetch: sb.fn })).toEqual({ ok: true, message: "Test text sent to your number ***-0199." });
    expect(sb.calls).toHaveLength(1);
    const headers = sb.calls[0].init.headers as Record<string, string>;
    expect(headers["sb-api-key-id"]).toBe("sb-panel-key-id");
    expect(headers["sb-api-secret-key"]).toBe("sb-panel-secret-key");
    expect(JSON.parse(String(sb.calls[0].init.body))).toEqual({ number: "+12125550199", content: TEST_SMS_TEXT, from_number: "+15550001111" });

    // A number that replied STOP is never texted.
    await sql`insert into app.sms_opt_outs (phone_e164, keyword) values ('+12125550199', 'STOP')`;
    expect(await runSettingsCheck(admin, "sms", { fetch: sb.fn })).toMatchObject({ ok: false, message: expect.stringContaining("replied STOP") });
    expect(sb.calls).toHaveLength(1);

    const rejected = fakeFetch({ status: "ERROR", error_code: 10001, error_key: "invalid_credentials" }, 401);
    await sql`delete from app.sms_opt_outs`;
    const failed = await runSettingsCheck(admin, "sms", { fetch: rejected.fn });
    expect(failed.ok).toBe(false);
    expect(failed.message).not.toContain("sb-panel");
  });

  it("sends the Twilio test text only to the admin's own number", async () => {
    const admin = await adminSession();
    expect(await runSettingsCheck(admin, "twilio")).toMatchObject({ ok: false, message: expect.stringContaining("Account SID and auth token") });
    const sid = "AC" + "0123456789abcdef".repeat(2);
    await setIntegrationSetting(admin, "TWILIO_ACCOUNT_SID", sid);
    await setIntegrationSetting(admin, "TWILIO_AUTH_TOKEN", "b".repeat(32));
    expect(await runSettingsCheck(admin, "twilio")).toMatchObject({ ok: false, message: expect.stringContaining("sending number") });
    await setIntegrationSetting(admin, "TWILIO_FROM_NUMBER", "+18885550100");

    const tw = fakeFetch({ sid: "SM7", status: "queued" }, 201);
    expect(await runSettingsCheck(admin, "twilio", { fetch: tw.fn })).toMatchObject({ ok: false, message: expect.stringContaining("Availability > Booking preferences") });
    expect(tw.calls).toHaveLength(0);

    await sql`insert into app.user_settings (user_id, sms_phone) values (${admin.id}, '+12125550199')`;
    expect(await runSettingsCheck(admin, "twilio", { fetch: tw.fn })).toEqual({ ok: true, message: "Test text sent through Twilio to your number ***-0199." });
    expect(Object.fromEntries(new URLSearchParams(String(tw.calls[0].init.body)))).toEqual({ To: "+12125550199", From: "+18885550100", Body: TEST_SMS_TEXT_TWILIO });

    const rejected = fakeFetch({ code: 20003, message: "Authenticate" }, 401);
    const failed = await runSettingsCheck(admin, "twilio", { fetch: rejected.fn });
    expect(failed).toMatchObject({ ok: false, message: expect.stringContaining("code_20003") });
    expect(failed.message).not.toContain("b".repeat(32));
  });

  it("is for admins only and records each check without values", async () => {
    const admin = await adminSession();
    const agent = await makeUser(sql, { role: "user" });
    await expect(runSettingsCheck(session(agent, "user"), "slack")).rejects.toMatchObject({ code: "forbidden" });

    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-LLLL");
    await runSettingsCheck(admin, "slack", { fetch: fakeFetch({ ok: true }).fn });
    const [entry] = await sql`select action, entity_type, entity_id, after from app.audit_log where action = 'settings.test'`;
    expect(entry).toMatchObject({ action: "settings.test", entity_type: "integration_setting", entity_id: "slack", after: { service: "slack", ok: true } });
    expect(JSON.stringify(await sql`select * from app.audit_log`)).not.toContain("xoxb-panel-token");
  });
});
