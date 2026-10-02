import "server-only";
import { z } from "zod";
import { service, type Db, type Sql } from "@/server/db/client";
import { env } from "@/server/env";
import { signRequest } from "@/server/crypto/hmac";
import { enqueue } from "@/server/jobs/queue";
import { PermanentJobError, RetryAfterError, type JobContext, type JobHandler, type JobRow } from "@/server/jobs/types";
import {
  buildLeadPayload,
  getEffectiveSfSettings,
  ID_PREFIX,
  isSalesforceId,
  SfSettingsError,
  type LeadPayload,
} from "@/server/salesforce/settings";

/**
 * sf_lead_create: sends one booking to the n8n lead workflow, which creates the Lead in
 * Salesforce. The app never talks to Salesforce directly.
 *
 * Outcomes (bookings.sf_lead_status):
 *   created    n8n returned created or existing; sf_lead_id is stored.
 *   duplicate  Salesforce rejected the Lead as a duplicate; the matched Lead Id is stored
 *              when n8n supplies one. Not retried.
 *   failed     Permanent rejection, or retries exhausted.
 *   skipped    Booking cancelled before the send, or lead creation disabled since enqueue.
 */

export const SF_LEAD_JOB_KIND = "sf_lead_create";
export const SF_LEAD_TIMEOUT_MS = 20_000;

export type SalesforceJobDeps = {
  fetch?: typeof fetch;
  /** Unix seconds, for signing. */
  now?: () => number;
  sql?: Sql;
  timeoutMs?: number;
};

const payloadSchema = z.object({ bookingId: z.string().uuid() });

const responseSchema = z.object({
  status: z.enum(["created", "existing", "duplicate", "error"]),
  leadId: z.string().nullish(),
  matchedRecordId: z.string().nullish(),
  error: z.string().nullish(),
  retryable: z.boolean().nullish(),
  problems: z.array(z.string()).nullish(),
});
export type LeadWebhookResponse = z.infer<typeof responseSchema>;

type BookingRow = {
  id: string;
  event_type_id: string;
  event_type_name: string;
  status: string;
  start_at: Date;
  end_at: Date;
  invitee_name: string;
  invitee_email: string;
  invitee_phone: string | null;
  invitee_timezone: string;
  language: string;
  sf_lead_id: string | null;
};

class RetryableLeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableLeadError";
  }
}

/**
 * Records the lead outcome on the booking and on every booking rescheduled from it, so a
 * reschedule that happened while the job was pending does not stay "pending" forever.
 */
async function setLeadStatus(db: Db, bookingId: string, status: string, leadId?: string | null): Promise<void> {
  await db`
    with recursive chain(id) as (
      select ${bookingId}::uuid
      union
      select b.id from app.bookings b join chain c on b.rescheduled_from_id = c.id
    )
    update app.bookings set sf_lead_status = ${status}, sf_lead_id = coalesce(${leadId ?? null}, sf_lead_id)
    where id in (select id from chain)
  `;
}

async function loadBooking(db: Db, bookingId: string): Promise<BookingRow | null> {
  const [b] = await db<BookingRow[]>`
    select b.id, b.event_type_id, et.name as event_type_name, b.status, b.start_at, b.end_at,
           b.invitee_name, b.invitee_email::text as invitee_email, b.invitee_phone, b.invitee_timezone,
           b.language, b.sf_lead_id
    from app.bookings b join app.event_types et on et.id = b.event_type_id
    where b.id = ${bookingId}
  `;
  return b ?? null;
}

async function loadPrimaryHost(db: Db, bookingId: string): Promise<{ email: string; name: string } | null> {
  const [h] = await db<{ email: string; name: string }[]>`
    select u.email::text as email, u.name
    from app.booking_hosts bh join app.users u on u.id = bh.user_id
    where bh.booking_id = ${bookingId} and bh.active
    order by (bh.role = 'primary') desc, u.email
    limit 1
  `;
  return h ?? null;
}

async function loadAnswers(db: Db, bookingId: string): Promise<Record<string, string>> {
  const rows = await db<{ question_key: string; value: string }[]>`
    select question_key, value from app.booking_answers where booking_id = ${bookingId}
  `;
  return Object.fromEntries(rows.map((r) => [r.question_key, r.value]));
}

/** Summary of the request for job_attempts. Field names only, never values. */
export function redactedSummary(url: string, payload: LeadPayload): Record<string, unknown> {
  return {
    method: "POST",
    url,
    leadFields: Object.keys(payload.lead).sort(),
    ownerMode: payload.owner.mode,
    autoAssign: payload.autoAssign,
    campaign: Boolean(payload.campaignId),
    options: payload.options,
  };
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), 3600);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(1, Math.min(3600, Math.ceil((at - Date.now()) / 1000)));
}

export function createSalesforceHandlers(deps: SalesforceJobDeps = {}): Record<string, JobHandler> {
  const handler: JobHandler = async (job: JobRow, ctx: JobContext) => {
    const sql = deps.sql ?? service();
    const isFinalAttempt = job.attempts >= job.max_attempts;

    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("Invalid sf_lead_create payload");
    const { bookingId } = parsed.data;

    const booking = await loadBooking(sql, bookingId);
    if (!booking) throw new PermanentJobError("Booking not found");

    if (booking.sf_lead_id) {
      // A retried job for a booking that already has a Lead must not create another one.
      await sql`
        update app.bookings set sf_lead_status = 'created'
        where id = ${bookingId} and coalesce(sf_lead_status, 'pending') in ('pending', 'failed')
      `;
      return { result: { skipped: "already_has_lead", leadId: booking.sf_lead_id } };
    }
    if (booking.status === "cancelled") {
      await setLeadStatus(sql, bookingId, "skipped");
      return { result: { skipped: "booking_cancelled" } };
    }

    const effective = await getEffectiveSfSettings(booking.event_type_id, sql);
    if (!effective.settings || !effective.settings.create_sf_lead) {
      await setLeadStatus(sql, bookingId, "skipped");
      return { result: { skipped: "lead_creation_disabled" } };
    }

    let payload: LeadPayload;
    try {
      payload = buildLeadPayload({
        booking: {
          id: booking.id,
          startAt: booking.start_at,
          endAt: booking.end_at,
          inviteeName: booking.invitee_name,
          inviteeEmail: booking.invitee_email,
          inviteePhone: booking.invitee_phone,
          inviteeTimezone: booking.invitee_timezone,
          language: booking.language,
        },
        eventTypeName: booking.event_type_name,
        host: await loadPrimaryHost(sql, bookingId),
        answers: await loadAnswers(sql, bookingId),
        settings: effective.settings,
      });
    } catch (err) {
      if (err instanceof SfSettingsError) {
        await setLeadStatus(sql, bookingId, "failed");
        throw new PermanentJobError(`Invalid Salesforce settings: ${err.message}`);
      }
      throw err;
    }

    const e = env();
    const url = `${e.N8N_BASE_URL.replace(/\/+$/, "")}${e.N8N_LEAD_WEBHOOK_PATH}`;
    ctx.log({ request: redactedSummary(url, payload) });

    const fail = async (err: Error): Promise<never> => {
      if (isFinalAttempt) await setLeadStatus(sql, bookingId, "failed");
      throw err;
    };

    if (!e.N8N_SIGNING_SECRET) return fail(new RetryableLeadError("N8N_SIGNING_SECRET is not configured"));

    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": bookingId,
      ...signRequest(e.N8N_SIGNING_SECRET, rawBody, deps.now?.()),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SF_LEAD_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await (deps.fetch ?? fetch)(url, { method: "POST", headers, body: rawBody, signal: controller.signal });
      text = await res.text();
    } catch (err) {
      const reason = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message;
      return fail(new RetryableLeadError(`n8n request failed: ${reason}`));
    } finally {
      clearTimeout(timer);
    }
    ctx.log({ responseCode: res.status });

    let body: LeadWebhookResponse | null = null;
    try {
      const json = responseSchema.safeParse(JSON.parse(text));
      if (json.success) body = json.data;
    } catch {
      body = null;
    }

    if (!body) {
      if (res.status === 429) {
        const after = parseRetryAfter(res.headers.get("retry-after"));
        if (after !== null) return fail(new RetryAfterError("n8n rate limited the request", after));
      }
      // 400, 413 and 422 without a contract body mean the request itself is unacceptable.
      if ([400, 413, 422].includes(res.status)) {
        await setLeadStatus(sql, bookingId, "failed");
        throw new PermanentJobError(`n8n rejected the request (HTTP ${res.status})`);
      }
      // 5xx, 429, 401 (secret or clock mismatch), 404 (workflow inactive): retry until fixed.
      return fail(new RetryableLeadError(`n8n returned HTTP ${res.status} without a valid response body`));
    }

    const result: Record<string, unknown> = {
      status: body.status,
      leadId: body.leadId ?? null,
      ...(body.matchedRecordId ? { matchedRecordId: body.matchedRecordId } : {}),
      ...(body.error ? { error: body.error } : {}),
      ...(body.problems?.length ? { problems: body.problems } : {}),
    };

    switch (body.status) {
      case "created":
      case "existing": {
        if (!isSalesforceId(body.leadId, [ID_PREFIX.lead])) {
          await setLeadStatus(sql, bookingId, "failed");
          throw new PermanentJobError(`n8n returned ${body.status} without a valid Lead Id`, result);
        }
        await setLeadStatus(sql, bookingId, "created", body.leadId);
        return { result };
      }
      case "duplicate": {
        const leadId = isSalesforceId(body.leadId, [ID_PREFIX.lead]) ? body.leadId : null;
        await setLeadStatus(sql, bookingId, "duplicate", leadId);
        throw new PermanentJobError(`Duplicate in Salesforce: ${body.error ?? "matched an existing record"}`, result);
      }
      case "error": {
        const message = `Salesforce lead create failed: ${body.error ?? "unknown error"}`;
        if (body.retryable === false) {
          await setLeadStatus(sql, bookingId, "failed");
          throw new PermanentJobError(message, result);
        }
        return fail(new RetryableLeadError(message));
      }
    }
  };
  return { [SF_LEAD_JOB_KIND]: handler };
}

/** Job handlers owned by the salesforce module. Keys are job kinds. */
export const salesforceHandlers: Record<string, JobHandler> = createSalesforceHandlers();

/**
 * Called by the booking module inside its booking transaction. When the event type's
 * effective settings enable lead creation, marks the booking pending and enqueues one
 * sf_lead_create job keyed by the booking id. Returns the job id, or null when disabled
 * or already enqueued.
 */
export async function enqueueSfLeadIfEnabled(tx: Db, bookingId: string, eventTypeId: string): Promise<string | null> {
  const effective = await getEffectiveSfSettings(eventTypeId, tx);
  if (!effective.settings?.create_sf_lead) return null;
  const jobId = await enqueue(tx, {
    kind: SF_LEAD_JOB_KIND,
    payload: { bookingId },
    idempotencyKey: bookingId,
    maxAttempts: env().SF_LEAD_MAX_ATTEMPTS,
    bookingId,
  });
  if (jobId) await tx`update app.bookings set sf_lead_status = 'pending' where id = ${bookingId} and sf_lead_id is null`;
  return jobId;
}
