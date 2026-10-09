import "server-only";
import { serviceTx, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { isReservedSlug } from "@/server/auth/slug";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import {
  answerKey,
  durationsFor,
  IMPORT_SOURCE,
  languageFor,
  mapBookingLocation,
  mapLocation,
  mapQuestions,
  safeSlug,
  urlSegments,
  userSlugFromCalendly,
  type CalendlyEventType,
  type CalendlySnapshot,
  type MappedLocation,
  type MappedQuestion,
} from "@/server/import/calendly/map";

/**
 * Imports a Calendly snapshot: users (pre-provisioned by email, linked at first sign-in),
 * teams and team members, event types with their questions, and scheduled meetings.
 *
 * - Idempotent: rows are keyed by (import_source, import_ref). Existing teams and event types
 *   are left as they are (admins may have edited them); missing team members are added.
 *   Existing bookings pick up cancellations and time changes from the snapshot.
 * - Silent: imported bookings never create jobs (see the jobs_skip_imported_bookings
 *   trigger), so no Outlook writes, emails, Slack messages or Salesforce leads.
 * - Dry run by default: everything runs in one transaction that is rolled back unless
 *   `apply` is true, so the report reflects real constraint checks.
 */

export type ImportReport = {
  applied: boolean;
  users: { created: number; existing: number };
  teams: { created: number; existing: number };
  teamMembers: { added: number };
  eventTypes: { created: number; existing: number; skipped: number };
  bookings: { created: number; updated: number; cancelled: number; unchanged: number; flagged: number; skipped: number };
  warnings: string[];
};

const MAX_WARNINGS = 300;
const DEFAULT_TZ = "America/New_York";

class DryRunRollback extends Error {}

export async function importCalendly(
  snapshot: CalendlySnapshot,
  opts: { apply: boolean; actorUserId: string | null; now?: Date },
): Promise<ImportReport> {
  const report: ImportReport = {
    applied: false,
    users: { created: 0, existing: 0 },
    teams: { created: 0, existing: 0 },
    teamMembers: { added: 0 },
    eventTypes: { created: 0, existing: 0, skipped: 0 },
    bookings: { created: 0, updated: 0, cancelled: 0, unchanged: 0, flagged: 0, skipped: 0 },
    warnings: [],
  };
  const warn = (m: string) => {
    if (report.warnings.length < MAX_WARNINGS) report.warnings.push(m);
  };

  try {
    await serviceTx(async (tx) => {
      // One import at a time.
      await tx`select pg_advisory_xact_lock(hashtext('calendly_import'))`;
      await runImport(tx, snapshot, report, warn, opts.now ?? new Date());
      await writeAudit(tx, {
        actorUserId: opts.actorUserId,
        action: "import.calendly",
        entityType: "import",
        after: { pulledAt: snapshot.pulledAt, ...summaryCounts(report) },
      });
      if (!opts.apply) throw new DryRunRollback();
    });
    report.applied = true;
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report;
}

function summaryCounts(r: ImportReport) {
  return { users: r.users, teams: r.teams, teamMembers: r.teamMembers, eventTypes: r.eventTypes, bookings: r.bookings, warnings: r.warnings.length };
}

type Ctx = {
  tx: Tx;
  warn: (m: string) => void;
  report: ImportReport;
  /** Calendly user URI -> { userId, email, timezone }. */
  users: Map<string, { userId: string; email: string; timezone: string }>;
  /** Calendly team URI -> team id. */
  teams: Map<string, string>;
  /** `${teamId}:${userId}` -> team member id. */
  members: Map<string, string>;
  /** Calendly event type URI -> hosts seen on its copied meetings. */
  bookedHosts: Map<string, Set<string>>;
  /** Calendly event type URI -> imported event type. */
  eventTypes: Map<string, { id: string; language: string; teamId: string | null; location: MappedLocation; questions: MappedQuestion[] }>;
};

async function runImport(tx: Tx, snap: CalendlySnapshot, report: ImportReport, warn: (m: string) => void, now: Date): Promise<void> {
  const bookedHosts = new Map<string, Set<string>>();
  for (const ev of snap.events) {
    const set = bookedHosts.get(ev.event_type) ?? new Set<string>();
    ev.hosts.forEach((h) => set.add(h));
    bookedHosts.set(ev.event_type, set);
  }
  const ctx: Ctx = { tx, warn, report, users: new Map(), teams: new Map(), members: new Map(), bookedHosts, eventTypes: new Map() };

  await importUsers(ctx, snap);

  // Active event types, plus inactive ones that still have meetings to copy.
  const referenced = new Set(snap.events.map((e) => e.event_type));
  const types = snap.eventTypes.filter((et) => et.active || referenced.has(et.uri));

  await importTeams(ctx, snap, types);
  for (const et of types) await importEventType(ctx, et);
  for (const ev of snap.events) await importBooking(ctx, ev, now);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function uniqueUserSlug(tx: Tx, base: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 60)}-${i}`;
    if (isReservedSlug(candidate)) continue;
    const [taken] = await tx`select 1 from app.users where slug = ${candidate}`;
    if (!taken) return candidate;
  }
  throw new Error(`Could not allocate a slug for ${base}`);
}

async function importUsers(ctx: Ctx, snap: CalendlySnapshot): Promise<void> {
  const { tx } = ctx;
  for (const m of snap.members) {
    const email = m.email.toLowerCase();
    const timezone = m.timezone || DEFAULT_TZ;
    const [existing] = await tx<{ id: string; timezone: string }[]>`select id, timezone from app.users where email = ${email}`;
    if (existing) {
      ctx.users.set(m.uri, { userId: existing.id, email, timezone: existing.timezone });
      ctx.report.users.existing++;
      continue;
    }
    const slug = await uniqueUserSlug(tx, userSlugFromCalendly(m.slug, m.name));
    // No entra_oid: the first Microsoft sign-in with this email links the account.
    const [row] = await tx<{ id: string }[]>`
      insert into app.users (email, name, slug, timezone, role)
      values (${email}, ${m.name}, ${slug}, ${timezone}, 'user')
      returning id
    `;
    await tx`
      insert into app.availability_schedules (owner_user_id, name, timezone, is_default)
      values (${row.id}, 'Working hours', ${timezone}, true)
    `;
    await tx`insert into app.user_settings (user_id) values (${row.id}) on conflict do nothing`;
    ctx.users.set(m.uri, { userId: row.id, email, timezone });
    ctx.report.users.created++;
  }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

async function uniqueTeamSlug(tx: Tx, base: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 60)}-${i}`;
    const [taken] = await tx`select 1 from app.teams where slug = ${candidate}`;
    if (!taken) return candidate;
  }
  throw new Error(`Could not allocate a team slug for ${base}`);
}

async function importTeams(ctx: Ctx, snap: CalendlySnapshot, types: CalendlyEventType[]): Promise<void> {
  const { tx } = ctx;
  const byTeam = new Map<string, CalendlyEventType[]>();
  for (const et of types) {
    if (et.profile.type !== "Team") continue;
    byTeam.set(et.profile.owner, [...(byTeam.get(et.profile.owner) ?? []), et]);
  }

  for (const [teamUri, teamTypes] of byTeam) {
    const name = teamTypes[0].profile.name;
    const [existing] = await tx<{ id: string }[]>`
      select id from app.teams where import_source = ${IMPORT_SOURCE} and import_ref = ${teamUri}
    `;
    let teamId: string;
    if (existing) {
      teamId = existing.id;
      ctx.report.teams.existing++;
    } else {
      const slug = await uniqueTeamSlug(tx, safeSlug(urlSegments(teamTypes[0].scheduling_url).owner, safeSlug(name, "team")));
      const [row] = await tx<{ id: string }[]>`
        insert into app.teams (name, slug, membership_source, import_source, import_ref)
        values (${name}, ${slug}, 'manual', ${IMPORT_SOURCE}, ${teamUri})
        returning id
      `;
      teamId = row.id;
      ctx.report.teams.created++;
    }
    ctx.teams.set(teamUri, teamId);

    // Members: every listed host, plus hosts of copied meetings (host lists can be incomplete).
    const typeUris = new Set(teamTypes.map((t) => t.uri));
    const hostUris = new Set<string>(teamTypes.flatMap((t) => t.hosts ?? []));
    for (const ev of snap.events) if (typeUris.has(ev.event_type)) ev.hosts.forEach((h) => hostUris.add(h));
    for (const t of teamTypes) {
      if (t.hosts?.length) continue;
      ctx.warn(
        ctx.bookedHosts.get(t.uri)?.size
          ? `Team page "${name} / ${t.name}" has no host list; using the hosts of its upcoming meetings.`
          : hostUris.size
            ? `Team page "${name} / ${t.name}" has no host list; it will use the whole team.`
            : `Team page "${name} / ${t.name}" has no known hosts; add team members before it can take bookings.`,
      );
    }

    for (const hostUri of hostUris) {
      const u = ctx.users.get(hostUri);
      if (!u) {
        ctx.warn(`Team "${name}": host ${hostUri} is not an organization member; skipped.`);
        continue;
      }
      const inserted = await tx<{ id: string }[]>`
        insert into app.team_members (team_id, user_id, email, status, source)
        values (${teamId}, ${u.userId}, ${u.email}, 'active', 'manual')
        on conflict (team_id, email) do nothing
        returning id
      `;
      if (inserted.length) ctx.report.teamMembers.added++;
      const [m] = await tx<{ id: string }[]>`select id from app.team_members where team_id = ${teamId} and email = ${u.email}`;
      ctx.members.set(`${teamId}:${u.userId}`, m.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

async function uniqueEventSlug(tx: Tx, owner: { userId: string | null; teamId: string | null }, base: string, language: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 60)}-${i}`;
    const [taken] = owner.teamId
      ? await tx`select 1 from app.event_types where team_id = ${owner.teamId} and slug = ${candidate} and language = ${language}`
      : await tx`select 1 from app.event_types where owner_user_id = ${owner.userId} and slug = ${candidate} and language = ${language}`;
    if (!taken) return candidate;
  }
  throw new Error(`Could not allocate an event slug for ${base}`);
}

async function importEventType(ctx: Ctx, et: CalendlyEventType): Promise<void> {
  const { tx } = ctx;
  const language = languageFor(et.name);
  const location = mapLocation(et.locations);
  const questions = mapQuestions(et.custom_questions, location.needsPhone);
  const isTeam = et.profile.type === "Team";
  const teamId = isTeam ? (ctx.teams.get(et.profile.owner) ?? null) : null;
  const ownerUserId = isTeam ? null : (ctx.users.get(et.profile.owner)?.userId ?? null);

  if (!teamId && !ownerUserId) {
    ctx.warn(`Event type "${et.name}" (${et.scheduling_url}): owner is not an organization member; skipped.`);
    ctx.report.eventTypes.skipped++;
    return;
  }

  const [existing] = await tx<{ id: string; language: string }[]>`
    select id, language from app.event_types where import_source = ${IMPORT_SOURCE} and import_ref = ${et.uri}
  `;
  if (existing) {
    const qs = await tx<{ key: string; label: { en?: string } }[]>`select key, label from app.event_type_questions where event_type_id = ${existing.id}`;
    ctx.eventTypes.set(et.uri, {
      id: existing.id,
      language: existing.language,
      teamId,
      location,
      questions: qs.map((q) => ({ key: q.key, label: q.label.en ?? "", type: "text", options: [], required: false, position: 0 })),
    });
    ctx.report.eventTypes.existing++;
    return;
  }

  const { durations, defaultDuration } = durationsFor(et);
  const slug = await uniqueEventSlug(tx, { userId: ownerUserId, teamId }, safeSlug(urlSegments(et.scheduling_url).event ?? et.slug, safeSlug(et.name, "meeting")), language);
  const description = et.description_plain?.trim() ? { [language]: et.description_plain.trim().slice(0, 5000) } : {};
  const mode = et.pooling_type ?? "individual";

  const [row] = await tx<{ id: string }[]>`
    insert into app.event_types (
      owner_user_id, team_id, slug, language, name, description, durations, default_duration,
      location_type, location_detail, booking_window_days, scheduling_mode, is_active, is_listed,
      import_source, import_ref
    ) values (
      ${ownerUserId}, ${teamId}, ${slug}, ${language}, ${et.name.slice(0, 200)}, ${tx.json(description)},
      ${durations}, ${defaultDuration}, ${location.type}, ${location.detail}, 60, ${mode},
      ${et.active}, ${!et.secret}, ${IMPORT_SOURCE}, ${et.uri}
    )
    returning id
  `;

  for (const q of questions) {
    await tx`
      insert into app.event_type_questions (event_type_id, key, type, label, options, required, position)
      values (${row.id}, ${q.key}, ${q.type}, ${tx.json({ [language]: q.label })}, ${tx.json(q.options)}, ${q.required}, ${q.position})
    `;
  }

  // Without a host list, the hosts of its copied meetings are the best available subset.
  const hostUris = et.hosts?.length ? et.hosts : [...(ctx.bookedHosts.get(et.uri) ?? [])];
  if (teamId && hostUris.length) {
    for (const hostUri of hostUris) {
      const u = ctx.users.get(hostUri);
      const memberId = u ? ctx.members.get(`${teamId}:${u.userId}`) : undefined;
      if (!memberId) continue;
      await tx`
        insert into app.event_type_hosts (event_type_id, team_member_id, is_required)
        values (${row.id}, ${memberId}, true)
        on conflict do nothing
      `;
    }
  }

  ctx.eventTypes.set(et.uri, { id: row.id, language, teamId, location, questions });
  ctx.report.eventTypes.created++;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

async function importBooking(ctx: Ctx, ev: CalendlySnapshot["events"][number], now: Date): Promise<void> {
  const { tx } = ctx;
  const type = ctx.eventTypes.get(ev.event_type);
  if (!type) {
    ctx.warn(`Meeting ${ev.uri}: its event type was not imported; skipped.`);
    ctx.report.bookings.skipped++;
    return;
  }
  const host = ev.hosts.map((h) => ctx.users.get(h)).find(Boolean);
  if (!host) {
    ctx.warn(`Meeting ${ev.uri}: host is not an organization member; skipped.`);
    ctx.report.bookings.skipped++;
    return;
  }
  const invitee = ev.invitees.find((i) => i.status === "active") ?? ev.invitees[0];
  if (!invitee) {
    ctx.warn(`Meeting ${ev.uri}: no invitee; skipped.`);
    ctx.report.bookings.skipped++;
    return;
  }
  if (ev.invitees.length > 1) ctx.warn(`Meeting ${ev.uri}: ${ev.invitees.length} invitees; only the first is copied.`);

  const start = new Date(ev.start_time);
  const end = new Date(ev.end_time);
  const cancelled = ev.status === "canceled" || invitee.status === "canceled";
  const range = `[${start.toISOString()},${end.toISOString()})`;

  const [existing] = await tx<{ id: string; status: string; start_at: Date; end_at: Date }[]>`
    select id, status, start_at, end_at from app.bookings where import_source = ${IMPORT_SOURCE} and import_ref = ${ev.uri}
  `;

  if (existing) {
    if (cancelled && existing.status !== "cancelled") {
      await tx`
        update app.bookings set status = 'cancelled', cancelled_by = 'system', cancelled_at = now(),
          cancel_reason = 'Cancelled in Calendly', updated_at = now()
        where id = ${existing.id}
      `;
      await tx`update app.booking_hosts set active = false where booking_id = ${existing.id}`;
      ctx.report.bookings.cancelled++;
    } else if (!cancelled && (existing.start_at.getTime() !== start.getTime() || existing.end_at.getTime() !== end.getTime())) {
      await tx`update app.bookings set start_at = ${start}, end_at = ${end}, updated_at = now() where id = ${existing.id}`;
      const moved = await setHostRange(tx, existing.id, range);
      if (!moved) await flagOverlap(tx, existing.id);
      ctx.report.bookings.updated++;
    } else {
      ctx.report.bookings.unchanged++;
    }
    return;
  }

  // New bookings: copy only meetings that are still on, and only upcoming ones.
  if (cancelled || end <= now) {
    ctx.report.bookings.skipped++;
    return;
  }

  const loc = mapBookingLocation(ev.location, type.location);
  const answers = (invitee.questions_and_answers ?? []).filter((qa) => qa.answer?.trim());
  const phoneAnswer = answers.find((qa) => answerKey(qa.question, type.questions) === "phone")?.answer ?? null;
  const phone = (invitee.text_reminder_number || loc.inviteePhone || phoneAnswer || null)?.slice(0, 40) ?? null;

  const [b] = await tx<{ id: string }[]>`
    insert into app.bookings (
      event_type_id, language, status, start_at, end_at, invitee_name, invitee_email, invitee_phone,
      invitee_timezone, location_type, location_detail, online_meeting_url, manage_token_hash,
      import_source, import_ref, created_at
    ) values (
      ${type.id}, ${type.language}, 'confirmed', ${start}, ${end}, ${invitee.name.slice(0, 200)},
      ${invitee.email.toLowerCase()}, ${phone}, ${invitee.timezone || host.timezone}, ${loc.type}, ${loc.detail},
      ${loc.meetingUrl}, ${sha256Hex(randomToken(32))}, ${IMPORT_SOURCE}, ${ev.uri},
      ${ev.created_at ? new Date(ev.created_at) : now}
    )
    returning id
  `;

  const memberId = type.teamId ? (ctx.members.get(`${type.teamId}:${host.userId}`) ?? null) : null;
  let inserted = true;
  try {
    await tx.savepoint(
      (sp) => sp`
        insert into app.booking_hosts (booking_id, user_id, team_member_id, role, blocked_range, active)
        values (${b.id}, ${host.userId}, ${memberId}, 'primary', ${range}::tstzrange, true)
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23P01") throw err;
    inserted = false;
  }
  if (!inserted) {
    await tx`
      insert into app.booking_hosts (booking_id, user_id, team_member_id, role, blocked_range, active)
      values (${b.id}, ${host.userId}, ${memberId}, 'primary', ${range}::tstzrange, false)
    `;
    await flagOverlap(tx, b.id);
    ctx.report.bookings.flagged++;
    ctx.warn(`Meeting ${ev.uri}: overlaps another booking for the same host; copied as flagged.`);
  }

  const used = new Set<string>();
  for (const qa of answers) {
    let key = answerKey(qa.question, type.questions) ?? `calendly_q${qa.position + 1}`;
    for (let i = 2; used.has(key); i++) key = `calendly_q${qa.position + 1}_${i}`;
    used.add(key);
    await tx`
      insert into app.booking_answers (booking_id, question_id, question_key, value)
      values (${b.id}, (select id from app.event_type_questions where event_type_id = ${type.id} and key = ${key}), ${key},
              ${String(qa.answer).slice(0, 5000)})
    `;
  }
  ctx.report.bookings.created++;
}

/** Moves a booking's host ranges; false when the new time overlaps another booking. */
async function setHostRange(tx: Tx, bookingId: string, range: string): Promise<boolean> {
  try {
    await tx.savepoint((sp) => sp`update app.booking_hosts set blocked_range = ${range}::tstzrange where booking_id = ${bookingId}`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== "23P01") throw err;
    await tx`update app.booking_hosts set blocked_range = ${range}::tstzrange, active = false where booking_id = ${bookingId}`;
    return false;
  }
}

async function flagOverlap(tx: Tx, bookingId: string): Promise<void> {
  await tx`
    update app.bookings set status = 'flagged', flagged_reason = 'Imported from Calendly; overlaps another booking for the same host'
    where id = ${bookingId}
  `;
}
