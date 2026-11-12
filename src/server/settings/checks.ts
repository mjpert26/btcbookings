import "server-only";
import { randomUUID } from "node:crypto";
import { withUser } from "@/server/db/client";
import { maskPhone, writeAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { sendEmail, type ResendLike } from "@/server/email/send";
import { siteverify } from "@/server/http/turnstile";
import { createSendblueClient } from "@/server/sms/sendblue";
import { createSlackClient, type FetchLike } from "@/server/slack/client";
import { integrationSettings, settingUnavailable, type IntegrationConfig } from "@/server/settings/integrations";
import { SettingsError } from "@/server/settings/admin";
import type { ManagedKey } from "@/server/settings/keys";

/**
 * Test buttons in Admin > Settings. Each check uses the values saved right now (a fresh read,
 * not the cache) and never contacts anyone other than the signed-in admin:
 *
 * - Email: sends one test email to the admin's own address.
 * - Slack: calls auth.test, which only checks the token. Nothing is posted.
 * - Turnstile: calls siteverify with the secret and a dummy token. invalid-input-secret means
 *   the secret is wrong; invalid-input-response means the secret was accepted. A secret that
 *   accepts the dummy token is a Cloudflare test key, which lets every request pass, so the
 *   check fails.
 * - Text messages: the SendBlue client has no read-only request, so one test text is sent to
 *   the admin's own mobile number (Availability > Booking preferences), unless it opted out.
 *
 * Results and audit entries never contain a key, secret or token.
 */

export const CHECK_SERVICES = ["email", "sms", "slack", "turnstile"] as const;

export type CheckService = (typeof CHECK_SERVICES)[number];

export type CheckResult = { ok: boolean; message: string };

export type CheckDeps = {
  /** Replaces fetch for Slack, Turnstile and SendBlue. */
  fetch?: FetchLike;
  /** Builds the Resend client for the email check. */
  resend?: (apiKey: string) => ResendLike;
};

/** Dummy token for the Turnstile check. Cloudflare rejects it with invalid-input-response. */
export const TURNSTILE_DUMMY_TOKEN = "btc-scheduler-settings-check";

export const TEST_SMS_TEXT = "BTC Scheduler: test message from Admin > Settings. Your SendBlue settings work.";

async function assertAdmin(user: SessionUser): Promise<void> {
  const ok = await withUser(user.id, async (tx) => (await tx<{ ok: boolean }[]>`select app.is_admin() as ok`)[0]?.ok);
  if (!ok) throw new SettingsError("forbidden", "Admin access required.");
}

async function recordCheck(user: SessionUser, service: CheckService, ok: boolean): Promise<void> {
  await withUser(user.id, (tx) =>
    writeAudit(tx, { actorUserId: user.id, action: "settings.test", entityType: "integration_setting", entityId: service, after: { service, ok } }),
  );
}

const UNAVAILABLE_MESSAGE =
  "The value saved here could not be read: the settings could not be loaded just now, or the stored secret no longer decrypts. Check the key below and set it again if it is marked unreadable.";

/** True when one of `keys` has no value because the saved settings could not be read. */
function unreadable(config: IntegrationConfig, ...keys: ManagedKey[]): boolean {
  return keys.some((key) => settingUnavailable(config, key));
}

/** A short, value-free description of an error from a provider client. */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "request failed";
  return message.slice(0, 200);
}

async function checkEmail(user: SessionUser, deps: CheckDeps): Promise<CheckResult> {
  const config = await integrationSettings({ fresh: true });
  if (unreadable(config, "RESEND_API_KEY")) return { ok: false, message: UNAVAILABLE_MESSAGE };
  if (!config.RESEND_API_KEY) return { ok: false, message: "No Resend API key is set here or in Vercel, so emails are logged instead of sent." };
  try {
    const sent = await sendEmail(
      {
        to: user.email,
        subject: "BTC Scheduler test email",
        text: "This is a test email from Admin > Settings in BTC Scheduler. Your Resend settings work.",
        html: "<p>This is a test email from Admin &gt; Settings in BTC Scheduler. Your Resend settings work.</p>",
        idempotencyKey: `settings-test:${randomUUID()}`,
        tag: "settings_test",
      },
      { config: { RESEND_API_KEY: config.RESEND_API_KEY, EMAIL_FROM: config.EMAIL_FROM }, resend: deps.resend },
    );
    if (sent.skipped) return { ok: false, message: "The email was not sent." };
    return { ok: true, message: `Test email sent to ${user.email} from ${config.EMAIL_FROM}.` };
  } catch (err) {
    return { ok: false, message: `Resend did not send the test email: ${safeError(err)}` };
  }
}

async function checkSlack(deps: CheckDeps): Promise<CheckResult> {
  const config = await integrationSettings({ fresh: true });
  if (unreadable(config, "SLACK_BOT_TOKEN")) return { ok: false, message: UNAVAILABLE_MESSAGE };
  if (!config.SLACK_BOT_TOKEN) return { ok: false, message: "No Slack bot token is set here or in Vercel." };
  try {
    const res = await createSlackClient({ token: config.SLACK_BOT_TOKEN, fetch: deps.fetch }).authTest();
    if (!res.ok) return { ok: false, message: `Slack rejected the bot token (${res.error ?? "unknown_error"}).` };
    const team = res.data?.team ? ` for workspace ${res.data.team}` : "";
    const bot = res.data?.user ? ` (bot user ${res.data.user})` : "";
    return { ok: true, message: `The bot token is valid${team}${bot}. Nothing was posted.` };
  } catch (err) {
    return { ok: false, message: `Slack could not be reached: ${safeError(err)}` };
  }
}

async function checkTurnstile(deps: CheckDeps): Promise<CheckResult> {
  const config = await integrationSettings({ fresh: true });
  if (unreadable(config, "TURNSTILE_SECRET_KEY")) return { ok: false, message: UNAVAILABLE_MESSAGE };
  if (!config.TURNSTILE_SECRET_KEY) return { ok: false, message: "No Turnstile secret key is set here or in Vercel, so the check is skipped on the public forms." };
  const siteKeyNote = config.TURNSTILE_SITE_KEY ? "" : " The site key is not set: set it too, or the public forms cannot pass the check.";
  let result: { success: boolean; errorCodes: string[] };
  try {
    result = await siteverify(config.TURNSTILE_SECRET_KEY, TURNSTILE_DUMMY_TOKEN, undefined, deps.fetch);
  } catch {
    return { ok: false, message: "Cloudflare could not be reached. Try again." };
  }
  if (result.errorCodes.includes("invalid-input-secret") || result.errorCodes.includes("missing-input-secret")) {
    return { ok: false, message: "Cloudflare rejected the secret key (invalid-input-secret). Check the value." };
  }
  if (result.success) {
    // A real secret key never accepts a made-up token; Cloudflare's always-pass test key does.
    return {
      ok: false,
      message:
        "This is a Cloudflare test secret key: Cloudflare accepted a made-up token, so every request would pass and bot protection is off. Use the secret key of your Turnstile widget.",
    };
  }
  if (result.errorCodes.includes("invalid-input-response")) {
    return { ok: true, message: `The secret key is valid. Cloudflare rejected only the dummy token, as expected.${siteKeyNote}` };
  }
  return { ok: false, message: `Cloudflare answered with ${result.errorCodes.join(", ") || "an unexpected response"}.` };
}

async function checkSms(user: SessionUser, deps: CheckDeps): Promise<CheckResult> {
  const config = await integrationSettings({ fresh: true });
  if (unreadable(config, "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET")) return { ok: false, message: UNAVAILABLE_MESSAGE };
  if (!config.SENDBLUE_API_KEY || !config.SENDBLUE_API_SECRET) {
    return { ok: false, message: "Set the SendBlue API key ID and secret key first." };
  }
  const { phone, optedOut } = await withUser(user.id, async (tx) => {
    const [settings] = await tx<{ sms_phone: string | null }[]>`select sms_phone from app.user_settings where user_id = ${user.id}`;
    const number = settings?.sms_phone ?? null;
    if (!number) return { phone: null, optedOut: false };
    const [opt] = await tx<{ phone_e164: string }[]>`select phone_e164 from app.sms_opt_outs where phone_e164 = ${number}`;
    return { phone: number, optedOut: Boolean(opt) };
  });
  if (!phone) {
    return {
      ok: false,
      message: "Add your own mobile number under Availability > Booking preferences first. The test text goes only to your number.",
    };
  }
  if (optedOut) return { ok: false, message: `Your number ${maskPhone(phone)} replied STOP. Text START to the sending number, then try again.` };
  try {
    const client = createSendblueClient({
      apiKey: config.SENDBLUE_API_KEY,
      apiSecret: config.SENDBLUE_API_SECRET,
      fromNumber: config.SENDBLUE_FROM_NUMBER,
      fetch: deps.fetch,
    });
    await client.sendMessage({ to: phone, content: TEST_SMS_TEXT });
    return { ok: true, message: `Test text sent to your number ${maskPhone(phone)}.` };
  } catch (err) {
    return { ok: false, message: `SendBlue did not send the test text: ${safeError(err)}` };
  }
}

/** Runs one test button's check for an admin and records it in the audit log. */
export async function runSettingsCheck(user: SessionUser, service: CheckService, deps: CheckDeps = {}): Promise<CheckResult> {
  if (!CHECK_SERVICES.includes(service)) throw new SettingsError("unknown_key", "Unknown check.");
  await assertAdmin(user);
  const result =
    service === "email" ? await checkEmail(user, deps) : service === "slack" ? await checkSlack(deps) : service === "turnstile" ? await checkTurnstile(deps) : await checkSms(user, deps);
  await recordCheck(user, service, result.ok);
  return result;
}
