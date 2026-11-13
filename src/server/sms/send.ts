import "server-only";
import { IntegrationSettingUnavailableError, integrationSettings, settingUnavailable, type IntegrationConfig } from "@/server/settings/integrations";
import type { ManagedKey } from "@/server/settings/keys";
import { redactPhone } from "@/server/sms/phone";
import { createSendblueClient, type SmsMessage, type SmsSendResult } from "@/server/sms/sendblue";
import { createTwilioClient } from "@/server/sms/twilio";

export type { SmsMessage, SmsSendResult } from "@/server/sms/sendblue";

/**
 * Sends one text through the configured provider (Admin > Settings, else Vercel).
 *
 * - Twilio when TWILIO_ACCOUNT_SID is set. SendBlue is then never used, even when Twilio's
 *   other settings are missing.
 * - SendBlue otherwise.
 *
 * Texts go only from the provider's sending number (TWILIO_FROM_NUMBER or
 * SENDBLUE_FROM_NUMBER). Without the provider's credentials or sending number, the text is
 * logged with a redacted number and reported as skipped, so jobs complete normally. When a
 * setting may be set in Admin > Settings but could not be read, it throws
 * IntegrationSettingUnavailableError so the job is retried.
 */

export type SmsProvider = "twilio" | "sendblue";

export type SmsTransport = (msg: SmsMessage) => Promise<SmsSendResult>;

let override: SmsTransport | null = null;

/** For tests: capture outgoing texts instead of calling a provider. Pass null to restore. */
export function setSmsTransport(transport: SmsTransport | null): void {
  override = transport;
}

/** The provider texts go through. Throws when that cannot be determined because the settings could not be read. */
export function smsProvider(config: IntegrationConfig): SmsProvider {
  if (config.TWILIO_ACCOUNT_SID) return "twilio";
  if (settingUnavailable(config, "TWILIO_ACCOUNT_SID")) throw new IntegrationSettingUnavailableError("TWILIO_ACCOUNT_SID");
  return "sendblue";
}

/** The first of `keys` that has no value, after checking that a missing value is not an unreadable one. */
function missing(config: IntegrationConfig, keys: readonly ManagedKey[]): ManagedKey | null {
  for (const key of keys) {
    if (config[key as keyof IntegrationConfig]) continue;
    if (settingUnavailable(config, key)) throw new IntegrationSettingUnavailableError(key);
    return key;
  }
  return null;
}

function skipped(key: ManagedKey, tag: string, to: string): SmsSendResult {
  console.info(`[sms] ${key} not set; not sent: ${tag} to ${redactPhone(to)}`);
  return { messageHandle: null, status: null, skipped: true };
}

export async function sendSms(msg: SmsMessage, tag: string): Promise<SmsSendResult> {
  if (override) return override(msg);
  const e = await integrationSettings();
  if (smsProvider(e) === "twilio") {
    const gap = missing(e, ["TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]);
    if (gap) return skipped(gap, tag, msg.to);
    return createTwilioClient({ accountSid: e.TWILIO_ACCOUNT_SID!, authToken: e.TWILIO_AUTH_TOKEN!, fromNumber: e.TWILIO_FROM_NUMBER! }).sendMessage(msg);
  }
  const gap = missing(e, ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER"]);
  if (gap) return skipped(gap, tag, msg.to);
  return createSendblueClient({ apiKey: e.SENDBLUE_API_KEY!, apiSecret: e.SENDBLUE_API_SECRET!, fromNumber: e.SENDBLUE_FROM_NUMBER! }).sendMessage(msg);
}
