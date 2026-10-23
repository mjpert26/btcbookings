import "server-only";
import { z } from "zod";
import { service, type Db, type Sql } from "@/server/db/client";
import { env } from "@/server/env";
import { signRequest } from "@/server/crypto/hmac";
import { enqueue } from "@/server/jobs/queue";
import {
  DeferJobError,
  PermanentJobError,
  RetryAfterError,
  type JobContext,
  type JobHandler,
  type JobRow,
} from "@/server/jobs/types";
import { resolvePageSettings } from "@/server/teams/page-settings";
import {
  buildLeadPayload,
  getEffectiveSfSettings,
  ID_PREFIX,
  isSalesforceId,
  SfSettingsError,
  type LeadPayload,
  type NoteQuestion,
  type SfSettingsRow,
} from "@/server/salesforce/settings";

/**
 * sf_lead_create: sends one booking to the n8n lead workflow, which matches, updates or
 * creates the Lead in Salesforce according to the event type's lead_mode. The app never
 * talks to Salesforce directly.
 *
 * Payload: { bookingId, isReschedule? }. isReschedule marks the job of a rescheduled
 * booking; n8n then only updates an existing open Lead.
 *
 * Reschedule chains: the newest booking's job owns the Salesforce work for the invitee.
 *   - A job of an earlier booking that runs after the reschedule (a retry, or a job that
 *     was already running) ends with result.skipped = 'superseded_by_reschedule'.
 *   - Before it calls n8n, the newest booking's job supersedes earlier jobs still waiting
 *     to run, and waits (without using an attempt) while one is running.
 *   - When an earlier booking's first-booking job never produced a Lead (superseded, or
 *     dead after failing), an isReschedule job takes over its intent and is sent as a
 *     first booking, so the invitee is still matched or created once.
 *
 * Outcomes (bookings.sf_lead_status):
 *   created    n8n returned created or existing; sf_lead_id is stored.
 *   updated    An existing open Lead was matched and marked Meeting Booked; its Id is stored.
 *   duplicate  Salesforce rejected the Lead as a duplicate; the matched Lead Id is stored
 *              when n8n supplies one. Not retried.
 *   failed     Permanent rejection, or retries exhausted.
 *   skipped    Booking cancelled before the send, lead creation disabled since enqueue, or
 *              n8n skipped the booking (converted Lead, or no open Lead in update-only mode
 *              or on a reschedule; the job result holds reason and matchedConvertedId).
 */

export const SF_LEAD_JOB_KIND = "sf_lead_create";
export const SF_LEAD_TIMEOUT_MS = 20_000;
/** Delay while an earlier booking of the same reschedule chain still has a lead job in flight. */
export const SF_LEAD_PREDECESSOR_WAIT_SECONDS = 60;

export type SalesforceJobDeps = {
  fetch?: typeof fetch;
  /** Unix seconds, for signing. */
  now?: () => number;
  sql?: Sql;
  timeoutMs?: number;
};

const payloadSchema = z.object({ bookingId: z.string().uuid(), isReschedule: z.boolean().optional() });

const responseSchema = z.object({
  status: z.enum(["created", "existing", "updated", "skipped", "duplicate", "error"]),
  leadId: z.string().nullish(),
  matchedRecordId: z.string().nullish(),
  /** skipped: the converted Lead that matched the invitee's email. */
  matchedConvertedId: z.string().nullish(),
  /** skipped: converted_lead, no_open_lead or reschedule_no_open_lead. */
  reason: z.string().max(200).nullish(),
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
  rescheduled_from_id: string | null;
  import_source: string | null;
  team_name: string | null;
  team_page_settings: unknown;
};

class RetryableLeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableLeadError";
  }
}

/**
 * Records the lead outcome on the booking and on the bookings rescheduled from it that have
 * no sf_lead_create job of their own (for example a reschedule in 'create' mode), so those
 * do not stay "pending" forever. A later booking with its own job keeps its own outcome,
 * and so do the bookings after it.
 */
async function setLeadStatus(db: Db, bookingId: string, status: string, leadId?: string | null): Promise<void> {
  await db`
    with recursive chain(id) as (
      select ${bookingId}::uuid
      union
      select b.id from app.bookings b join chain c on b.rescheduled_from_id = c.id
      where not exists (select 1 from app.jobs j where j.kind = ${SF_LEAD_JOB_KIND} and j.booking_id = b.id)
    )
    update app.bookings set sf_lead_status = ${status}, sf_lead_id = coalesce(${leadId ?? null}, sf_lead_id)
    where id in (select id from chain)
  `;
}

async function loadBooking(db: Db, bookingId: string): Promise<BookingRow | null> {
  // A variant normally carries its parent's team; the parent's is used when it does not.
  const [b] = await db<BookingRow[]>`
    select b.id, b.event_type_id, et.name as event_type_name, b.status, b.start_at, b.end_at,
           b.invitee_name, b.invitee_email::text as invitee_email, b.invitee_phone, b.invitee_timezone,
           b.language, b.sf_lead_id, b.rescheduled_from_id, b.import_source,
           t.name as team_name, t.page_settings as team_page_settings
    from app.bookings b
    join app.event_types et on et.id = b.event_type_id
    left join app.event_types pet on pet.id = et.parent_event_type_id
    left join app.teams t on t.id = coalesce(et.team_id, pet.team_id)
    where b.id = ${bookingId}
  `;
  return b ?? null;
}

/**
 * The booking's primary host. A rescheduled booking has no active host any more; its hosts
 * at the time of the reschedule (not reassigned away) are used instead.
 */
async function loadPrimaryHost(db: Db, bookingId: string): Promise<{ email: string; name: string } | null> {
  const [h] = await db<{ email: string; name: string }[]>`
    select u.email::text as email, u.name
    from app.booking_hosts bh
    join app.users u on u.id = bh.user_id
    join app.bookings b on b.id = bh.booking_id
    where bh.booking_id = ${bookingId}
      and (bh.active or (b.status = 'rescheduled' and bh.reassigned_at is null))
    order by bh.active desc, (bh.role = 'primary') desc, u.email
    limit 1
  `;
  return h ?? null;
}

/** Answers by question key, plus the metadata of the questions that still exist. */
async function loadAnswers(db: Db, bookingId: string): Promise<{ answers: Record<string, string>; questions: NoteQuestion[] }> {
  const rows = await db<{ question_key: string; value: string; type: string | null; label: Record<string, string> | null; position: number | null }[]>`
    select a.question_key, a.value, q.type::text as type, q.label, q.position
    from app.booking_answers a left join app.event_type_questions q on q.id = a.question_id
    where a.booking_id = ${bookingId}
  `;
  return {
    answers: Object.fromEntries(rows.map((r) => [r.question_key, r.value])),
    questions: rows
      .filter((r) => r.type !== null)
      .map((r) => ({ key: r.question_key, type: r.type, label: r.label, position: r.position })),
  };
}

/** An earlier booking of a reschedule chain and its sf_lead_create job, if any. */
export type ChainEntry = {
  booking_id: string;
  depth: number;
  sf_lead_id: string | null;
  sf_lead_status: string | null;
  job_id: string | null;
  job_status: string | null;
  job_payload: { isReschedule?: boolean } | null;
  job_result: Record<string, unknown> | null;
};

/** The bookings this booking was rescheduled from, nearest first, with their lead jobs. */
async function predecessorChain(db: Db, bookingId: string): Promise<ChainEntry[]> {
  return db<ChainEntry[]>`
    with recursive chain(id, depth) as (
      select rescheduled_from_id, 1 from app.bookings where id = ${bookingId} and rescheduled_from_id is not null
      union all
      select b.rescheduled_from_id, c.depth + 1
      from app.bookings b join chain c on b.id = c.id
      where b.rescheduled_from_id is not null and c.depth < 100
    )
    select c.id as booking_id, c.depth, b.sf_lead_id, b.sf_lead_status,
           j.id as job_id, j.status::text as job_status, j.payload as job_payload, j.result as job_result
    from chain c
    join app.bookings b on b.id = c.id
    left join lateral (
      select x.id, x.status, x.payload, x.result from app.jobs x
      where x.kind = ${SF_LEAD_JOB_KIND} and x.booking_id = c.id
      order by x.created_at desc
      limit 1
    ) j on true
    order by c.depth
  `;
}

/**
 * True when an earlier booking's first-booking lead job never produced a Lead, so the
 * caller's isReschedule job should take over and send the booking as a first booking.
 * Walks back from the nearest earlier booking: a superseded reschedule job passes the
 * decision to the booking before it; a superseded first-booking job, or a dead one that
 * did not end as a duplicate, means the intent is still open. A Lead, a booking without a
 * lead job, or a job with a final outcome means the reschedule only updates.
 */
export function chainCreateIntentOpen(chain: ChainEntry[]): boolean {
  for (const p of chain) {
    if (p.sf_lead_id || !p.job_id) return false;
    const superseded = p.job_status === "succeeded" && p.job_result?.skipped === "superseded_by_reschedule";
    if (p.job_payload?.isReschedule === true) {
      if (superseded) continue;
      return false;
    }
    if (superseded) return true;
    return p.job_status === "dead" && p.sf_lead_status !== "duplicate";
  }
  return false;
}

/**
 * Marks waiting lead jobs (pending, or failed and waiting to retry) of the given earlier
 * bookings as superseded by `newBookingId`, and those bookings' lead status 'skipped' when
 * they have no Lead. The conditional update is safe against a worker claiming a job at the
 * same moment: once a job is running it no longer matches. Returns the superseded jobs.
 */
async function supersedeWaitingJobs(
  db: Db,
  bookingIds: string[],
  newBookingId: string,
): Promise<{ booking_id: string; payload: { isReschedule?: boolean } }[]> {
  if (!bookingIds.length) return [];
  const rows = await db<{ booking_id: string; payload: { isReschedule?: boolean } }[]>`
    update app.jobs set status = 'succeeded', locked_until = null,
           result = ${db.json({ skipped: "superseded_by_reschedule", bookingId: newBookingId })}
    where kind = ${SF_LEAD_JOB_KIND} and booking_id = any(${bookingIds}::uuid[]) and status in ('pending', 'failed')
    returning booking_id, payload
  `;
  if (rows.length) {
    await db`
      update app.bookings set sf_lead_status = 'skipped'
      where id = any(${rows.map((r) => r.booking_id)}::uuid[]) and sf_lead_id is null
    `;
  }
  return rows;
}

/** True when a booking rescheduled from this one (directly or later) has its own lead job. */
async function laterBookingOwnsLead(db: Db, bookingId: string): Promise<boolean> {
  const rows = await db`
    with recursive later(id, depth) as (
      select id, 1 from app.bookings where rescheduled_from_id = ${bookingId}
      union all
      select b.id, l.depth + 1 from app.bookings b join later l on b.rescheduled_from_id = l.id
      where l.depth < 100
    )
    select 1 from app.jobs j
    where j.kind = ${SF_LEAD_JOB_KIND} and j.booking_id in (select id from later)
    limit 1
  `;
  return rows.length > 0;
}

/** Summary of the request for job_attempts. Field names and flags only, never values. */
export function redactedSummary(url: string, payload: LeadPayload): Record<string, unknown> {
  return {
    method: "POST",
    url,
    mode: payload.mode,
    isReschedule: payload.isReschedule,
    leadFields: Object.keys(payload.lead).sort(),
    ownerMode: payload.owner.mode,
    autoAssign: payload.autoAssign,
    campaign: Boolean(payload.campaignId),
    options: payload.options,
    noteText: Boolean(payload.noteText),
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
    let isReschedule = parsed.data.isReschedule === true;

    const booking = await loadBooking(sql, bookingId);
    if (!booking) throw new PermanentJobError("Booking not found");
    // The jobs_skip_imported_bookings trigger keeps these jobs out; this is a second guard.
    if (booking.import_source) return { result: { skipped: "imported_booking" } };

    const fail = async (err: Error): Promise<never> => {
      if (isFinalAttempt) await setLeadStatus(sql, bookingId, "failed");
      throw err;
    };

    // A reschedule updates the Lead the booking already carries, so only a first booking
    // stops here once it has a Lead.
    if (booking.sf_lead_id && !isReschedule) {
      // A retried job for a booking that already has a Lead must not create another one.
      await sql`
        update app.bookings set sf_lead_status = 'created'
        where id = ${bookingId} and coalesce(sf_lead_status, 'pending') in ('pending', 'failed')
      `;
      return { result: { skipped: "already_has_lead", leadId: booking.sf_lead_id } };
    }
    // The booking was rescheduled and a later booking's job owns the Salesforce work. Only
    // this booking's own status is touched; the later bookings keep their own outcomes.
    if (booking.status === "rescheduled" && (await laterBookingOwnsLead(sql, bookingId))) {
      await sql`
        update app.bookings set sf_lead_status = 'skipped'
        where id = ${bookingId} and sf_lead_id is null and coalesce(sf_lead_status, 'pending') = 'pending'
      `;
      return { result: { skipped: "superseded_by_reschedule" } };
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
    let tookOver = false;
    if (booking.rescheduled_from_id) {
      let chain = await predecessorChain(sql, bookingId);
      // Earlier jobs still waiting to run are superseded now rather than after their backoff.
      const superseded = await supersedeWaitingJobs(
        sql,
        chain.filter((p) => p.job_status === "pending" || p.job_status === "failed").map((p) => p.booking_id),
        bookingId,
      );
      if (superseded.length) chain = await predecessorChain(sql, bookingId);
      // Wait for a running earlier job, so an update never overtakes the Lead it creates.
      // The wait does not use up this job's attempts.
      if (chain.some((p) => p.job_status === "running")) {
        throw new DeferJobError("Waiting for the Salesforce job of the original booking", SF_LEAD_PREDECESSOR_WAIT_SECONDS);
      }
      if (isReschedule && !booking.sf_lead_id && chainCreateIntentOpen(chain)) {
        // The original booking never got its Lead: send this booking as a first booking.
        isReschedule = false;
        tookOver = true;
        await sql`update app.jobs set payload = payload - 'isReschedule' where id = ${job.id}`;
      }
    }
    if (isReschedule && effective.settings.lead_mode === "create") {
      // The settings changed to "always create" after the reschedule; that mode never sends reschedules.
      await setLeadStatus(sql, bookingId, "skipped");
      return { result: { skipped: "reschedule_in_create_mode" } };
    }

    const { answers, questions } = await loadAnswers(sql, bookingId);
    const partner = booking.team_name
      ? { displayName: resolvePageSettings(booking.team_page_settings).displayName ?? booking.team_name }
      : null;

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
        answers,
        questions,
        partner,
        isReschedule,
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
      mode: payload.mode,
      ...(isReschedule ? { isReschedule: true } : {}),
      ...(tookOver ? { tookOverOriginal: true } : {}),
      ...(body.matchedRecordId ? { matchedRecordId: body.matchedRecordId } : {}),
      ...(isSalesforceId(body.matchedConvertedId, [ID_PREFIX.lead]) ? { matchedConvertedId: body.matchedConvertedId } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
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
      case "updated": {
        if (!isSalesforceId(body.leadId, [ID_PREFIX.lead])) {
          await setLeadStatus(sql, bookingId, "failed");
          throw new PermanentJobError("n8n returned updated without a valid Lead Id", result);
        }
        await setLeadStatus(sql, bookingId, "updated", body.leadId);
        return { result };
      }
      case "skipped": {
        // A converted Lead, or no open Lead to update. A final outcome, not an error.
        await setLeadStatus(sql, bookingId, "skipped");
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

/**
 * Salesforce work for a reschedule. Call inside the reschedule transaction, after the new
 * booking is inserted. `settings` are the effective settings of the event type (after
 * variant inheritance).
 *
 * - Lead creation off, or lead_mode 'create': nothing (reschedules never call Salesforce
 *   in that mode, as before).
 * - The original booking is imported from Calendly: nothing.
 * - The original booking's own lead job has not run yet (pending, or waiting to retry) and
 *   it has no Lead: that job is superseded (marked succeeded with
 *   result.skipped = 'superseded_by_reschedule') and the new booking's job takes over its
 *   intent, so the booking is matched or created once, with the new time. The same holds
 *   when an earlier first-booking job is dead without a Lead (chainCreateIntentOpen).
 * - Otherwise: one job for the new booking with isReschedule = true, which n8n treats as
 *   update only. If the original job is still running, the new job waits for it and then
 *   decides again when it runs (see the handler).
 *
 * The job is keyed by the new booking's id, so it is enqueued once. Returns the job id, or
 * null when nothing was enqueued.
 */
export async function enqueueSfLeadOnReschedule(
  tx: Db,
  input: {
    oldBookingId: string;
    newBookingId: string;
    settings: Pick<SfSettingsRow, "create_sf_lead" | "lead_mode"> | null | undefined;
  },
): Promise<string | null> {
  const { settings, oldBookingId, newBookingId } = input;
  if (!settings?.create_sf_lead || settings.lead_mode === "create") return null;
  const [old] = await tx<{ import_source: string | null; sf_lead_id: string | null }[]>`
    select import_source, sf_lead_id from app.bookings where id = ${oldBookingId}
  `;
  if (!old || old.import_source) return null;

  let isReschedule = true;
  if (!old.sf_lead_id) {
    const [superseded] = await supersedeWaitingJobs(tx, [oldBookingId], newBookingId);
    if (superseded) isReschedule = superseded.payload?.isReschedule === true;
    if (isReschedule && chainCreateIntentOpen(await predecessorChain(tx, newBookingId))) isReschedule = false;
  }

  const jobId = await enqueue(tx, {
    kind: SF_LEAD_JOB_KIND,
    payload: isReschedule ? { bookingId: newBookingId, isReschedule: true } : { bookingId: newBookingId },
    idempotencyKey: newBookingId,
    maxAttempts: env().SF_LEAD_MAX_ATTEMPTS,
    bookingId: newBookingId,
  });
  if (jobId) await tx`update app.bookings set sf_lead_status = 'pending' where id = ${newBookingId}`;
  return jobId;
}
