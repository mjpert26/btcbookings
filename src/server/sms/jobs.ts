import "server-only";
import { z } from "zod";
import { service, type Sql } from "@/server/db/client";
import { isLocale, type Locale } from "@/i18n/locales";
import { PermanentJobError, type JobContext, type JobHandler, type JobResult, type JobRow } from "@/server/jobs/types";
import { bookingById } from "@/server/booking/view";
import { buildInviteeData } from "@/server/email/jobs";
import { loadAgentReminderData, reminderDisabledReason, reminderSkipReason } from "@/server/email/reminders";
import { loadReminderSettings } from "@/server/booking/side-effects";
import { isOptedOut } from "@/server/sms/opt-out";
import { normalizeE164, redactPhone } from "@/server/sms/phone";
import { sendSms } from "@/server/sms/sendblue";
import { agentReminderSms, merchantReminderSms } from "@/server/sms/templates";

const payloadSchema = z.object({
  template: z.literal("booking_reminder"),
  bookingId: z.uuid(),
  recipient: z.union([z.literal("invitee"), z.object({ userId: z.uuid() })]),
  offsetMin: z.number().int().positive(),
});

function skip(reason: string): JobResult {
  return { result: { skipped: reason } };
}

/**
 * sms_send: one reminder text to the merchant (invitee_phone) or to a host
 * (user_settings.sms_phone). Loads fresh booking state and the event type's current
 * reminder settings, normalizes the number to E.164, and never sends to an invalid or
 * opted-out number. Merchant texts also require the consent recorded at booking time
 * (bookings.sms_consent_at).
 */
export async function handleSmsSend(
  job: Pick<JobRow, "id" | "payload">,
  ctx: Pick<JobContext, "log">,
  opts: { sql?: Sql; now?: number } = {},
): Promise<JobResult> {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError("Invalid sms_send payload");
  const p = parsed.data;
  const sql = opts.sql ?? service();
  const booking = await bookingById(sql, p.bookingId);
  if (!booking) return skip("booking_not_found");
  const audience = p.recipient === "invitee" ? "merchant" : "agent";
  const now = opts.now ?? Date.now();
  const reason = reminderSkipReason(audience, booking, p.offsetMin, now);
  if (reason) return skip(reason);
  const disabled = reminderDisabledReason(await loadReminderSettings(sql, p.bookingId), audience, "sms", p.offsetMin);
  if (disabled) return skip(disabled);

  let rawPhone: string | null;
  let body: string;
  if (p.recipient === "invitee") {
    rawPhone = booking.invitee_phone;
    const phone = normalizeE164(rawPhone);
    if (!phone) return skip(rawPhone ? "invalid_phone" : "no_phone");
    if (!booking.sms_consent_at) return skip("no_consent");
    if (await isOptedOut(sql, phone)) return skip("opted_out");
    const data = await buildInviteeData(sql, booking);
    body = merchantReminderSms({
      locale: (isLocale(booking.language) ? booking.language : "en") as Locale,
      eventName: data.eventName,
      partnerName: data.partnerName ?? null,
      start: booking.start_at,
      timezone: booking.invitee_timezone,
      joinUrl: booking.location_type === "teams" ? booking.online_meeting_url : null,
      manageUrl: data.manageUrl,
    });
    return send(ctx, phone, body, booking.language);
  }

  const data = await loadAgentReminderData(sql, booking, p.recipient.userId, p.offsetMin, now);
  if (!data) return skip("not_a_host");
  const [settings] = await sql<{ sms_phone: string | null }[]>`
    select sms_phone from app.user_settings where user_id = ${p.recipient.userId}
  `;
  rawPhone = settings?.sms_phone ?? null;
  const phone = normalizeE164(rawPhone);
  if (!phone) return skip(rawPhone ? "invalid_phone" : "no_phone");
  if (await isOptedOut(sql, phone)) return skip("opted_out");
  body = agentReminderSms(data);
  return send(ctx, phone, body, "en");
}

async function send(ctx: Pick<JobContext, "log">, phone: string, body: string, locale: string): Promise<JobResult> {
  ctx.log({ request: { channel: "sms", to: redactPhone(phone), locale, length: body.length } });
  const sent = await sendSms({ to: phone, content: body }, "booking_reminder");
  ctx.log({ responseCode: sent.skipped ? 0 : 200 });
  return { result: { sent: !sent.skipped, providerId: sent.messageHandle, status: sent.status } };
}

/** Job handlers owned by the sms module. Keys are job kinds. */
export const smsHandlers: Record<string, JobHandler> = {
  sms_send: (job, ctx) => handleSmsSend(job, ctx),
};
