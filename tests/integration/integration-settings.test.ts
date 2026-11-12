import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { setServiceClient, withUser, type Sql } from "@/server/db/client";
import type { SessionUser } from "@/server/auth/session";
import { DEFAULT_EMAIL_FROM, resetEnvCache } from "@/server/env";
import { encryptSecret } from "@/server/crypto/aes";
import { sendEmail, type ResendLike } from "@/server/email/send";
import { verifyTurnstile } from "@/server/http/turnstile";
import { slackClientFromSettings } from "@/server/slack/client";
import { checkPushBearer } from "@/server/sync/http";
import { CACHE_TTL_MS, integrationSettings, invalidateIntegrationSettings, resetIntegrationSettingsCache } from "@/server/settings/integrations";
import { listIntegrationSettings, removeIntegrationSetting, setIntegrationSetting, SettingsError } from "@/server/settings/admin";
import { runSettingsCheck, TEST_SMS_TEXT, TURNSTILE_DUMMY_TOKEN } from "@/server/settings/checks";
import { settingAad } from "@/server/settings/keys";

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

  it("falls back to the environment when the database cannot be read, and logs no values", async () => {
    const admin = await adminSession();
    await setIntegrationSetting(admin, "SLACK_BOT_TOKEN", "xoxb-panel-token-EEEE");
    resetIntegrationSettingsCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = (() =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED postgres://app:hunter2@db.internal/app"), { code: "ECONNREFUSED" }))) as unknown as Sql;
    setServiceClient(failing);
    try {
      const cfg = await integrationSettings();
      expect(cfg.SLACK_BOT_TOKEN).toBe("xoxb-test");
      expect(cfg.N8N_SIGNING_SECRET).toBe("test-n8n-signing-secret");
    } finally {
      setServiceClient(sql);
    }
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("xoxb-");
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
    expect(Object.keys(views)).toHaveLength(13);
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
    expect(rows.map((r) => [r.action, r.entity_type, r.entity_id])).toEqual([
      ["settings.update", "integration_setting", "SLACK_BOT_TOKEN"],
      ["settings.update", "integration_setting", "SLACK_BOT_TOKEN"],
      ["settings.remove", "integration_setting", "SLACK_BOT_TOKEN"],
      ["settings.update", "integration_setting", "EMAIL_FROM"],
    ]);
    expect(rows.every((r) => r.actor_user_id === admin.id)).toBe(true);
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [
        { key: "SLACK_BOT_TOKEN", source: "vercel", last4: "test" },
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "AAAA" },
      ],
      [
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "AAAA" },
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "BBBB" },
      ],
      [
        { key: "SLACK_BOT_TOKEN", source: "panel", last4: "BBBB" },
        { key: "SLACK_BOT_TOKEN", source: "vercel", last4: "test" },
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
    expect(await verifyTurnstile(null)).toEqual({ ok: true });
    await setIntegrationSetting(admin, "TURNSTILE_SECRET_KEY", "0x-panel-turnstile-secret");
    expect(await verifyTurnstile(null)).toEqual({ ok: false, reason: "missing_token" });
    const cf = fakeFetch({ success: true });
    expect(await verifyTurnstile("token-1", "203.0.113.9", cf.fn as unknown as typeof fetch)).toEqual({ ok: true });
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

    await setIntegrationSetting(admin, "TURNSTILE_SITE_KEY", "0x-panel-site-key");
    const both = await runSettingsCheck(admin, "turnstile", { fetch: valid.fn });
    expect(both.message).not.toContain("The site key is not set");
  });

  it("sends the test text only to the admin's own number, with the panel credentials", async () => {
    const admin = await adminSession();
    expect(await runSettingsCheck(admin, "sms")).toMatchObject({ ok: false, message: expect.stringContaining("API key ID and secret key") });
    await setIntegrationSetting(admin, "SENDBLUE_API_KEY", "sb-panel-key-id");
    await setIntegrationSetting(admin, "SENDBLUE_API_SECRET", "sb-panel-secret-key");
    await setIntegrationSetting(admin, "SENDBLUE_FROM_NUMBER", "+15550001111");

    const sb = fakeFetch({ status: "QUEUED", message_handle: "mh_1" });
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
