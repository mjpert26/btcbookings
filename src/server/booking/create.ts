import "server-only";
import { randomUUID } from "node:crypto";
import { service, type Db } from "@/server/db/client";
import { decryptSecret } from "@/server/crypto/aes";
import { loadPool, loadPublicEventType, type LoadedEventType } from "@/server/booking/load";
import { pickDuration } from "@/server/booking/slots";
import { bookingInputSchema, fieldErrors, validateAnswers } from "@/server/booking/validation";
import {
  blockedRange,
  chooseHosts,
  confirmSlot,
  EXCLUSION_VIOLATION,
  fetchLiveBusy,
  insertBookingHosts,
  lockAssignment,
  pgCode,
  priorHostsForInvitee,
  recordRoundRobin,
  UNIQUE_VIOLATION,
  type ChosenHost,
} from "@/server/booking/engine";
import { enqueueBookingCreated, issueManageToken } from "@/server/booking/side-effects";
import { bookingById, buildPublicView } from "@/server/booking/view";
import {
  BookingNotFoundError,
  BookingValidationError,
  SlotTakenError,
  type BookingInput,
  type BookingOptions,
  type BookingResult,
} from "@/server/booking/types";

const MINUTE = 60_000;

/** Thrown inside the transaction when an idempotent replay is detected; never escapes. */
class Replay extends Error {
  constructor(readonly bookingId: string) {
    super("replay");
  }
}

function scopedIdempotencyKey(eventTypeId: string, key: string | null | undefined): string | null {
  return key ? `${eventTypeId}:${key}` : null;
}

async function findReplay(db: Db, key: string | null): Promise<string | null> {
  if (!key) return null;
  const [row] = await db<{ id: string }[]>`select id from app.bookings where idempotency_key = ${key}`;
  return row?.id ?? null;
}

/**
 * Returns the existing booking for an idempotent retry. The stored token is decrypted so
 * the client gets the same manage link. A key reused with different details is rejected.
 */
async function replayResult(db: Db, bookingId: string, email: string, startMs: number): Promise<BookingResult> {
  const [row] = await db<{ manage_token_enc: string | null; invitee_email: string; start_at: Date }[]>`
    select manage_token_enc, invitee_email, start_at from app.bookings where id = ${bookingId}
  `;
  if (!row || !row.manage_token_enc || row.invitee_email !== email || row.start_at.getTime() !== startMs) {
    throw new BookingValidationError({ idempotencyKey: "conflict" });
  }
  const booking = (await bookingById(db, bookingId))!;
  return {
    token: decryptSecret(row.manage_token_enc, bookingId),
    view: await buildPublicView(db, booking),
    replayed: true,
  };
}

/**
 * Creates a booking (PLAN 4.3). Validation happens first; the availability check, host
 * assignment and all inserts happen in one transaction serialized per team (or host) by
 * an advisory lock. The booking_hosts exclusion constraint is the final guard: a
 * violation means another transaction (for example a different team sharing the host)
 * took the time, and round-robin retries once with the next candidate.
 */
export async function createBooking(input: BookingInput, opts: BookingOptions = {}): Promise<BookingResult> {
  const sql = service();
  const now = opts.now ?? Date.now();

  const parsed = bookingInputSchema.safeParse(input);
  if (!parsed.success) throw new BookingValidationError(fieldErrors(parsed.error));
  const v = parsed.data;

  const loaded = await loadPublicEventType(sql, v.owner, v.eventSlug, v.language);
  if (!loaded) throw new BookingNotFoundError();
  const et = loaded.resolved.eventType;
  const durationMin = pickDuration(loaded, v.durationMin);
  const answers = validateAnswers(loaded.resolved.questions, v.answers, v.phone);
  if (!answers.ok) throw new BookingValidationError(answers.errors);

  const startMs = Date.parse(v.start);
  const endMs = startMs + durationMin * MINUTE;
  if (!Number.isFinite(startMs) || startMs <= now) throw new SlotTakenError();
  if (startMs % MINUTE !== 0) throw new SlotTakenError();

  const idemKey = scopedIdempotencyKey(et.id, v.idempotencyKey);
  const existing = await findReplay(sql, idemKey);
  if (existing) return replayResult(sql, existing, v.email, startMs);

  // Live calendar pre-check (outside the transaction, bounded by a timeout).
  const range = blockedRange(loaded, startMs, endMs);
  const prePool = opts.liveBusy ? await loadPool(sql, loaded) : [];
  const liveBusy = await fetchLiveBusy(
    opts.liveBusy,
    prePool.filter((p) => p.eligible).map((p) => p.userId),
    range.from,
    range.to,
    opts.liveBusyTimeoutMs,
  );

  let bookingId: string;
  let token: string;
  try {
    ({ bookingId, token } = await sql.begin(async (tx) => {
      await lockAssignment(tx, loaded);
      const replay = await findReplay(tx, idemKey);
      if (replay) throw new Replay(replay);

      const confirmed = await confirmSlot(tx, loaded, {
        startMs,
        durationMin,
        now,
        liveBusy,
        lockMembers: true,
      });
      if (!confirmed) throw new SlotTakenError();

      const preferred =
        et.scheduling_mode === "round_robin" && et.rr_sticky_returning_invitee && et.team_id
          ? await priorHostsForInvitee(tx, et.team_id, v.email)
          : [];

      const exclude = new Set<string>();
      for (let attempt = 0; attempt < 2; attempt++) {
        const hosts = chooseHosts(loaded, confirmed, { preferredUserIds: preferred, exclude });
        if (!hosts) throw new SlotTakenError();
        const id = randomUUID();
        const issued = issueManageToken(id);
        try {
          await tx.savepoint(async (sp) => {
            await insertBooking(sp, loaded, {
              id,
              startMs,
              endMs,
              name: v.name,
              email: v.email,
              phone: answers.value.phone,
              timezone: v.timezone,
              tokenHash: issued.hash,
              tokenEnc: issued.encrypted,
              idempotencyKey: idemKey,
            });
            await insertBookingHosts(sp, id, hosts, range);
            for (const a of answers.value.answers) {
              await sp`
                insert into app.booking_answers (booking_id, question_id, question_key, value)
                values (${id}, ${a.questionId}, ${a.key}, ${a.value})
              `;
            }
          });
        } catch (err) {
          if (pgCode(err) === EXCLUSION_VIOLATION) {
            if (et.scheduling_mode === "round_robin" && attempt === 0) {
              exclude.add(hosts[0].userId);
              continue;
            }
            throw new SlotTakenError();
          }
          if (pgCode(err) === UNIQUE_VIOLATION && idemKey) {
            const again = await findReplay(tx, idemKey);
            if (again) throw new Replay(again);
          }
          throw err;
        }
        await afterInsert(tx, loaded, id, hosts, startMs, now);
        return { bookingId: id, token: issued.token };
      }
      throw new SlotTakenError();
    }));
  } catch (err) {
    if (err instanceof Replay) return replayResult(sql, err.bookingId, v.email, startMs);
    if (pgCode(err) === UNIQUE_VIOLATION && idemKey) {
      const again = await findReplay(sql, idemKey);
      if (again) return replayResult(sql, again, v.email, startMs);
    }
    if (pgCode(err) === EXCLUSION_VIOLATION) throw new SlotTakenError();
    throw err;
  }

  const booking = (await bookingById(sql, bookingId))!;
  return { token, view: await buildPublicView(sql, booking), replayed: false };
}

export async function insertBooking(
  db: Db,
  loaded: LoadedEventType,
  b: {
    id: string;
    startMs: number;
    endMs: number;
    name: string;
    email: string;
    phone: string | null;
    timezone: string;
    tokenHash: string;
    tokenEnc: string;
    idempotencyKey: string | null;
    rescheduledFromId?: string | null;
    sfLeadId?: string | null;
    sfLeadStatus?: string | null;
  },
): Promise<void> {
  const et = loaded.resolved.eventType;
  await db`
    insert into app.bookings (
      id, event_type_id, language, status, start_at, end_at, invitee_name, invitee_email,
      invitee_phone, invitee_timezone, location_type, location_detail, manage_token_hash,
      manage_token_enc, idempotency_key, rescheduled_from_id, sf_lead_id, sf_lead_status
    ) values (
      ${b.id}, ${et.id}, ${et.language}, 'confirmed', ${new Date(b.startMs)}, ${new Date(b.endMs)},
      ${b.name}, ${b.email}, ${b.phone}, ${b.timezone}, ${et.location_type}, ${et.location_detail},
      ${b.tokenHash}, ${b.tokenEnc}, ${b.idempotencyKey}, ${b.rescheduledFromId ?? null},
      ${b.sfLeadId ?? null}, ${b.sfLeadStatus ?? null}
    )
  `;
}

async function afterInsert(
  db: Db,
  loaded: LoadedEventType,
  bookingId: string,
  hosts: ChosenHost[],
  startMs: number,
  now: number,
): Promise<void> {
  const et = loaded.resolved.eventType;
  if (et.scheduling_mode === "round_robin") await recordRoundRobin(db, hosts[0].teamMemberId);
  await enqueueBookingCreated(db, {
    bookingId,
    startMs,
    reminderOffsetsMin: et.reminder_offsets_min,
    hostUserIds: hosts.map((h) => h.userId),
    resolved: loaded.resolved,
    now,
  });
}
