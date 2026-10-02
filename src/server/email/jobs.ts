import "server-only";
import { z } from "zod";
import { service, type Sql } from "@/server/db/client";
import { env } from "@/server/env";
import { decryptSecret } from "@/server/crypto/aes";
import { isLocale, pickLocalized, type Locale } from "@/i18n/locales";
import { PermanentJobError, type JobContext, type JobHandler, type JobResult, type JobRow } from "@/server/jobs/types";
import { bookingById, bookingHosts, chainRoot, eventInfo, type BookingRow } from "@/server/booking/view";
import { eventPath } from "@/server/booking/load";
import { buildIcs } from "@/server/booking/ics";
import { redactEmail, sendEmail, type OutgoingEmail } from "@/server/email/send";
import { renderHostConflict, renderHostNotice, renderInviteeEmail, type RenderedEmail } from "@/server/email/render";
import { locationText, type InviteeEmailData, type InviteeKind } from "@/server/email/templates/invitee";

const payloadSchema = z.object({
  template: z.enum([
    "booking_confirmed",
    "booking_rescheduled",
    "booking_cancelled",
    "booking_reminder",
    "host_conflict_flagged",
    "host_booking_notice",
  ]),
  bookingId: z.uuid(),
  recipient: z.union([z.literal("invitee"), z.object({ userId: z.uuid() })]),
  offsetMin: z.number().int().positive().optional(),
});

type Payload = z.infer<typeof payloadSchema>;

const INVITEE_KIND: Record<string, InviteeKind> = {
  booking_confirmed: "confirmed",
  booking_rescheduled: "rescheduled",
  booking_cancelled: "cancelled",
  booking_reminder: "reminder",
};

/** Reminders that would arrive this early (start moved later) are skipped. */
const REMINDER_EARLY_TOLERANCE_MS = 10 * 60_000;

function skip(reason: string): JobResult {
  return { result: { skipped: reason } };
}

/**
 * Decides from FRESH booking state whether an email should still go out. Exported for
 * tests. Returns a skip reason, or null to send.
 */
export function skipReason(p: Payload, b: BookingRow, now: number): string | null {
  const live = b.status === "confirmed" || b.status === "flagged";
  switch (p.template) {
    case "booking_cancelled":
      return b.status === "cancelled" ? null : "not_cancelled";
    case "booking_confirmed":
    case "booking_rescheduled":
      return live ? null : `status_${b.status}`;
    case "booking_reminder": {
      if (b.status !== "confirmed") return `status_${b.status}`;
      const start = b.start_at.getTime();
      if (now >= start) return "started";
      if (!p.offsetMin) return "no_offset";
      const due = start - p.offsetMin * 60_000;
      if (now < due - REMINDER_EARLY_TOLERANCE_MS) return "start_moved";
      return null;
    }
    case "host_booking_notice":
      return null;
    case "host_conflict_flagged":
      return b.status === "flagged" ? null : `status_${b.status}`;
  }
}

async function manageUrl(sql: Sql, bookingId: string): Promise<string | null> {
  const [row] = await sql<{ manage_token_enc: string | null }[]>`
    select manage_token_enc from app.bookings where id = ${bookingId}
  `;
  if (!row?.manage_token_enc) return null;
  try {
    return `${env().APP_BASE_URL}/b/${decryptSecret(row.manage_token_enc, bookingId)}`;
  } catch {
    return null;
  }
}

function logoUrl(): string {
  return `${env().APP_BASE_URL}/brand/btc-logo.png`;
}

export async function buildInviteeData(sql: Sql, b: BookingRow): Promise<InviteeEmailData> {
  const [info, active, all, manage] = await Promise.all([
    eventInfo(sql, b.event_type_id),
    bookingHosts(sql, b.id, true),
    bookingHosts(sql, b.id, false),
    manageUrl(sql, b.id),
  ]);
  const hosts = active.length ? active : all;
  const base = env().APP_BASE_URL;
  const bookable = info && info.is_active && info.owner_active && info.owner_slug;
  return {
    locale: (isLocale(b.language) ? b.language : "en") as Locale,
    inviteeName: b.invitee_name,
    eventName: info?.name ?? "",
    start: b.start_at,
    end: b.end_at,
    timezone: b.invitee_timezone,
    hostNames: hosts.map((h) => h.name),
    locationType: b.location_type,
    locationDetail: b.location_type === "teams" ? null : b.location_detail,
    onlineMeetingUrl: b.online_meeting_url,
    manageUrl: manage,
    bookAgainUrl: bookable ? `${base}${eventPath(info.owner_kind, info.owner_slug!, info.slug, info.language)}` : null,
    logoUrl: logoUrl(),
  };
}

async function inviteeEmail(sql: Sql, p: Payload, b: BookingRow): Promise<{ rendered: RenderedEmail; ics?: string }> {
  const kind = INVITEE_KIND[p.template];
  const data = await buildInviteeData(sql, b);
  const rendered = await renderInviteeEmail(kind, data);
  if (kind !== "confirmed" && kind !== "rescheduled") return { rendered };
  const { rootId, depth } = await chainRoot(sql, b.id);
  const loc = locationText(data);
  const ics = buildIcs({
    uid: `${rootId}@btc-scheduler`,
    sequence: depth,
    start: b.start_at,
    end: b.end_at,
    title: data.eventName,
    description: [data.hostNames.join(", "), data.manageUrl].filter(Boolean).join("\n"),
    location: loc.url ?? loc.text,
    url: data.manageUrl ?? undefined,
    organizerName: data.hostNames[0],
  });
  return { rendered, ics };
}

async function hostEmail(sql: Sql, p: Payload, b: BookingRow, userId: string): Promise<{ rendered: RenderedEmail; to: string } | null> {
  const hosts = await bookingHosts(sql, b.id, false);
  const host = hosts.find((h) => h.user_id === userId);
  if (!host) return null;
  const info = await eventInfo(sql, b.event_type_id);
  const dashboardUrl = `${env().APP_BASE_URL}/dashboard`;
  if (p.template === "host_conflict_flagged") {
    const [row] = await sql<{ flagged_reason: string | null }[]>`select flagged_reason from app.bookings where id = ${b.id}`;
    return {
      to: host.email,
      rendered: await renderHostConflict({
        hostName: host.name,
        eventName: info?.name ?? "",
        start: b.start_at,
        end: b.end_at,
        timezone: host.timezone,
        inviteeName: b.invitee_name,
        reason: row?.flagged_reason ?? null,
        dashboardUrl,
        logoUrl: logoUrl(),
      }),
    };
  }
  const answers = await sql<{ label: Record<string, string> | null; question_key: string; value: string }[]>`
    select q.label, a.question_key, a.value
    from app.booking_answers a left join app.event_type_questions q on q.id = a.question_id
    where a.booking_id = ${b.id}
    order by q.position nulls last, a.question_key
  `;
  return {
    to: host.email,
    rendered: await renderHostNotice({
      kind: b.status === "cancelled" ? "cancelled" : b.rescheduled_from_id ? "rescheduled" : "created",
      hostName: host.name,
      eventName: info?.name ?? "",
      start: b.start_at,
      end: b.end_at,
      timezone: host.timezone,
      inviteeName: b.invitee_name,
      inviteeEmail: b.invitee_email,
      inviteePhone: b.invitee_phone,
      inviteeTimezone: b.invitee_timezone,
      answers: answers.map((a) => ({ label: pickLocalized(a.label, "en") || a.question_key, value: a.value })),
      cancelReason: b.cancel_reason,
      dashboardUrl,
      logoUrl: logoUrl(),
    }),
  };
}

export async function handleEmailSend(
  job: Pick<JobRow, "id" | "payload" | "idempotency_key">,
  ctx: Pick<JobContext, "log">,
  opts: { sql?: Sql; now?: number } = {},
): Promise<JobResult> {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError("Invalid email_send payload");
  const p = parsed.data;
  const sql = opts.sql ?? service();
  const booking = await bookingById(sql, p.bookingId);
  if (!booking) return skip("booking_not_found");
  const reason = skipReason(p, booking, opts.now ?? Date.now());
  if (reason) return skip(reason);

  let email: OutgoingEmail;
  const idempotencyKey = `email_send:${job.idempotency_key ?? job.id}`;
  if (p.recipient === "invitee") {
    if (p.template === "host_booking_notice" || p.template === "host_conflict_flagged") {
      throw new PermanentJobError("Host template addressed to the invitee");
    }
    const { rendered, ics } = await inviteeEmail(sql, p, booking);
    email = {
      to: booking.invitee_email,
      ...rendered,
      attachments: ics ? [{ filename: "invite.ics", content: ics, contentType: "text/calendar; charset=utf-8" }] : undefined,
      idempotencyKey,
      tag: p.template,
    };
  } else {
    const host = await hostEmail(sql, p, booking, p.recipient.userId);
    if (!host) return skip("not_a_host");
    email = { to: host.to, ...host.rendered, idempotencyKey, tag: p.template };
  }

  ctx.log({ request: { template: p.template, to: redactEmail(email.to), locale: booking.language } });
  const sent = await sendEmail(email);
  ctx.log({ responseCode: sent.skipped ? 0 : 200 });
  return { result: { sent: !sent.skipped, providerId: sent.id } };
}

/** Job handlers owned by the email module. Keys are job kinds. */
export const emailHandlers: Record<string, JobHandler> = {
  email_send: (job, ctx) => handleEmailSend(job, ctx),
};
