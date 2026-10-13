import "server-only";
import { DateTime } from "luxon";
import { serviceTx, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { isReservedSlug } from "@/server/auth/slug";
import { allowedEmailDomains } from "@/server/env";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import { pickLocalized } from "@/i18n/locales";
import {
  answerKey,
  blockedRange,
  durationsFor,
  IMPORT_SOURCE,
  isCancelled,
  languageFor,
  LIMITS,
  mapAvailability,
  mapBookingLocation,
  mapLocation,
  mapQuestions,
  safeSlug,
  urlSegments,
  userSlugFromCalendly,
  type CalendlyEvent,
  type CalendlyEventType,
  type CalendlySnapshot,
  type MappedLocation,
} from "@/server/import/calendly/map";

/**
 * Imports a Calendly snapshot: users (pre-provisioned by email, linked at first sign-in) with
 * their Calendly working hours, teams and team members, event types with their questions,
 * and upcoming meetings.
 *
 * - Dormant: imported event types are created inactive, so nothing becomes bookable until an
 *   admin takes pages live (src/server/import/calendly/cutover.ts). Calendly's own active,
 *   secret and kind flags are kept in event_types.import_meta for that step.
 * - Silent: imported bookings never create jobs (see the jobs_skip_imported_bookings
 *   trigger), so no Outlook writes, emails, Slack messages or Salesforce leads.
 * - Idempotent: rows are keyed by (import_source, import_ref); users fall back to email. Existing
 *   users, teams, team members and event types are left as they are (admins may have edited
 *   them), except that Calendly's flags in import_meta are refreshed. Existing bookings pick up
 *   Calendly cancellations, time changes and host reassignments, and imported bookings in the
 *   snapshot's window that are missing from it are cancelled. Cancellations run before moves
 *   and inserts, so a reschedule frees the old time before the new one is held.
 * - Guarded: a snapshot older than the last applied one is refused, and so is a snapshot that
 *   would cancel an unusually large share of imported bookings as missing.
 * - Dry run by default: everything runs in one transaction that is rolled back unless
 *   `apply` is true, so the report reflects real constraint checks.
 */

export type ImportReport = {
  applied: boolean;
  elapsedMs: number;
  users: { created: number; existing: number; schedulesImported: number };
  teams: { created: number; existing: number };
  teamMembers: { added: number };
  eventTypes: { created: number; existing: number; skipped: number; goLiveEligible: number };
  bookings: {
    created: number;
    updated: number;
    reassigned: number;
    cancelled: number;
    cancelledMissing: number;
    restored: number;
    unchanged: number;
    flagged: number;
    skipped: number;
  };
  warnings: string[];
};

export class ImportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefusedError";
  }
}

const MAX_WARNINGS = 400;
const DEFAULT_TZ = "America/New_York";

class DryRunRollback extends Error {}

export async function importCalendly(
  snapshot: CalendlySnapshot,
  opts: { apply: boolean; actorUserId: string | null; now?: Date },
): Promise<ImportReport> {
  if (opts.apply && snapshot.placeholder) {
    throw new ImportRefusedError("This snapshot contains placeholder emails and can only be used for a dry run.");
  }
  const started = Date.now();
  const report: ImportReport = {
    applied: false,
    elapsedMs: 0,
    users: { created: 0, existing: 0, schedulesImported: 0 },
    teams: { created: 0, existing: 0 },
    teamMembers: { added: 0 },
    eventTypes: { created: 0, existing: 0, skipped: 0, goLiveEligible: 0 },
    bookings: { created: 0, updated: 0, reassigned: 0, cancelled: 0, cancelledMissing: 0, restored: 0, unchanged: 0, flagged: 0, skipped: 0 },
    warnings: [],
  };
  const warn = (m: string) => {
    if (report.warnings.length < MAX_WARNINGS) report.warnings.push(m);
  };

  try {
    await serviceTx(async (tx) => {
      // One import at a time.
      await tx`select pg_advisory_xact_lock(hashtext('calendly_import'))`;
      const [last] = await tx<{ pulled_at: Date | null }[]>`
        select max((after ->> 'pulledAt')::timestamptz) as pulled_at from app.audit_log where action = 'import.calendly'
      `;
      if (last?.pulled_at && new Date(snapshot.pulledAt) < last.pulled_at) {
        const msg = `This snapshot was pulled at ${snapshot.pulledAt}, before the last applied one (${last.pulled_at.toISOString()}).`;
        if (opts.apply) throw new ImportRefusedError(`${msg} Pull a fresh snapshot.`);
        warn(`${msg} It cannot be applied.`);
      }
      await runImport(tx, snapshot, report, warn, opts.now ?? new Date(), opts.apply);
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
  report.elapsedMs = Date.now() - started;
  return report;
}

function summaryCounts(r: ImportReport) {
  return { users: r.users, teams: r.teams, teamMembers: r.teamMembers, eventTypes: r.eventTypes, bookings: r.bookings, warnings: r.warnings.length };
}

type UserRef = { userId: string; email: string; timezone: string };
type ImportedType = { id: string; language: "en" | "es"; teamId: string | null; location: MappedLocation; questions: { key: string; label: string }[] };
type ExistingBooking = {
  id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  import_ref: string;
  flagged_reason: string | null;
  host_user_id: string | null;
  host_active: boolean | null;
};

const OVERLAP_REASON = "Imported from Calendly; overlaps another booking for the same host";
/** cancelMissing refuses to apply when more than this share of the window would be cancelled. */
const MISSING_SHARE_LIMIT = 0.25;
const MISSING_FLOOR = 10;

type Ctx = {
  tx: Tx;
  warn: (m: string) => void;
  report: ImportReport;
  today: string;
  /** Calendly user URI -> app user. */
  users: Map<string, UserRef>;
  /** Lowercased email -> existing app user. */
  usersByEmail: Map<string, { id: string; timezone: string; importRef: string | null }>;
  /** Calendly user URI -> existing app user linked by import_ref. */
  usersByRef: Map<string, { id: string; email: string; timezone: string }>;
  userSlugs: Set<string>;
  teamSlugs: Set<string>;
  /** Calendly team URI -> existing imported team id. */
  teamsByRef: Map<string, string>;
  /** Calendly team URI -> team id (this run). */
  teams: Map<string, string>;
  /** `${teamId}:${userId}` -> team member id. */
  members: Map<string, string>;
  /** `${ownerOrTeamId}:${language}` -> event slugs in use. */
  eventSlugs: Map<string, Set<string>>;
  /** Calendly event type URI -> existing imported event type. */
  eventTypesByRef: Map<string, { id: string; language: "en" | "es" }>;
  /** Calendly event type URI -> hosts seen on its meetings in the snapshot. */
  bookedHosts: Map<string, Set<string>>;
  /** Calendly event type URI -> imported event type (this run). */
  eventTypes: Map<string, ImportedType>;
  bookingsByRef: Map<string, ExistingBooking>;
};

/** One record per meeting URI; a cancelled copy wins over an active one. */
function uniqueEvents(events: CalendlyEvent[], warn: (m: string) => void): CalendlyEvent[] {
  const byUri = new Map<string, CalendlyEvent>();
  for (const ev of events) {
    const prev = byUri.get(ev.uri);
    if (prev) {
      warn(`Meeting ${ev.uri} appears more than once in the snapshot; using one copy.`);
      if (isCancelled(prev) && !isCancelled(ev)) continue;
    }
    byUri.set(ev.uri, ev);
  }
  return [...byUri.values()];
}

async function runImport(tx: Tx, snap: CalendlySnapshot, report: ImportReport, warn: (m: string) => void, now: Date, apply: boolean): Promise<void> {
  const events = uniqueEvents(snap.events, warn);
  const bookedHosts = new Map<string, Set<string>>();
  for (const ev of events) {
    const set = bookedHosts.get(ev.event_type) ?? new Set<string>();
    ev.hosts.forEach((h) => set.add(h));
    bookedHosts.set(ev.event_type, set);
  }

  // Preload what the import compares against, so per-row work is inserts only.
  const [users, teams, types, bookings] = await Promise.all([
    tx<{ id: string; email: string; timezone: string; slug: string; import_ref: string | null }[]>`
      select id, email::text as email, timezone, slug, case when import_source = ${IMPORT_SOURCE} then import_ref end as import_ref
      from app.users`,
    tx<{ id: string; slug: string; import_ref: string | null }[]>`
      select id, slug, case when import_source = ${IMPORT_SOURCE} then import_ref end as import_ref from app.teams`,
    tx<{ id: string; language: "en" | "es"; slug: string; owner: string; import_ref: string | null }[]>`
      select id, language, slug, coalesce(team_id, owner_user_id)::text as owner,
             case when import_source = ${IMPORT_SOURCE} then import_ref end as import_ref
      from app.event_types`,
    tx<ExistingBooking[]>`
      select b.id, b.status::text as status, b.start_at, b.end_at, b.import_ref, b.flagged_reason,
             bh.user_id as host_user_id, bh.active as host_active
      from app.bookings b
      left join app.booking_hosts bh on bh.booking_id = b.id and bh.role = 'primary'
      where b.import_source = ${IMPORT_SOURCE}`,
  ]);

  const eventSlugs = new Map<string, Set<string>>();
  for (const t of types) {
    const key = `${t.owner}:${t.language}`;
    eventSlugs.set(key, (eventSlugs.get(key) ?? new Set()).add(t.slug));
  }

  const ctx: Ctx = {
    tx,
    warn,
    report,
    today: DateTime.fromJSDate(now).toUTC().toISODate()!,
    users: new Map(),
    usersByEmail: new Map(users.map((u) => [u.email.toLowerCase(), { id: u.id, timezone: u.timezone, importRef: u.import_ref }])),
    usersByRef: new Map(users.filter((u) => u.import_ref).map((u) => [u.import_ref!, { id: u.id, email: u.email.toLowerCase(), timezone: u.timezone }])),
    userSlugs: new Set(users.map((u) => u.slug)),
    teamSlugs: new Set(teams.map((t) => t.slug)),
    teamsByRef: new Map(teams.filter((t) => t.import_ref).map((t) => [t.import_ref!, t.id])),
    teams: new Map(),
    members: new Map(),
    eventSlugs,
    eventTypesByRef: new Map(types.filter((t) => t.import_ref).map((t) => [t.import_ref!, { id: t.id, language: t.language }])),
    bookedHosts,
    eventTypes: new Map(),
    bookingsByRef: new Map(bookings.map((b) => [b.import_ref, b])),
  };

  await importUsers(ctx, snap, now);

  // Active event types, plus inactive ones that still have meetings to copy.
  const referenced = new Set(events.map((e) => e.event_type));
  const selected = snap.eventTypes.filter((et) => et.active || referenced.has(et.uri));

  await importTeams(ctx, selected);
  await loadExistingQuestions(ctx, selected);
  for (const et of selected) await importEventType(ctx, et);
  await refreshImportMeta(ctx, snap.eventTypes);

  // Bookings in three passes, so freed time is available to the moves and inserts after it.
  const existing = events.filter((ev) => ctx.bookingsByRef.has(ev.uri));
  for (const ev of existing) if (isCancelled(ev)) await cancelExisting(ctx, ctx.bookingsByRef.get(ev.uri)!);
  await cancelMissing(ctx, snap, events, apply);
  for (const ev of existing) if (!isCancelled(ev)) await syncExisting(ctx, ctx.bookingsByRef.get(ev.uri)!, ev);
  for (const ev of events) if (!ctx.bookingsByRef.has(ev.uri)) await importBooking(ctx, ev, now);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function allocate(taken: Set<string>, base: string, reserved: (s: string) => boolean = () => false): string {
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 60)}-${i}`;
    if (reserved(candidate) || taken.has(candidate)) continue;
    taken.add(candidate);
    return candidate;
  }
  throw new Error(`Could not allocate a slug for ${base}`);
}

async function importUsers(ctx: Ctx, snap: CalendlySnapshot, now: Date): Promise<void> {
  const { tx } = ctx;
  const domains = allowedEmailDomains();
  for (const m of snap.members) {
    const email = m.email.toLowerCase();
    // The Calendly link wins: sign-in may have changed the stored email since the last import.
    const linked = ctx.usersByRef.get(m.uri);
    if (linked) {
      ctx.users.set(m.uri, { userId: linked.id, email: linked.email, timezone: linked.timezone });
      ctx.report.users.existing++;
      continue;
    }
    const existing = ctx.usersByEmail.get(email);
    if (existing) {
      if (!existing.importRef) {
        await tx`update app.users set import_source = ${IMPORT_SOURCE}, import_ref = ${m.uri} where id = ${existing.id}`;
        existing.importRef = m.uri;
      } else if (existing.importRef !== m.uri) {
        ctx.warn(`Member ${m.name} (${email}) matches a user already linked to another Calendly member; using that user.`);
      }
      ctx.users.set(m.uri, { userId: existing.id, email, timezone: existing.timezone });
      ctx.report.users.existing++;
      continue;
    }
    if (!domains.includes(email.split("@")[1] ?? "")) {
      ctx.warn(`Member ${m.name} (${email}) is outside the allowed sign-in domains and will never be able to sign in.`);
    }
    const timezone = m.availability?.timezone || m.timezone || DEFAULT_TZ;
    const slug = allocate(ctx.userSlugs, userSlugFromCalendly(m.slug, m.name), isReservedSlug);
    // No entra_oid: the first Microsoft sign-in with this email links the account.
    const [row] = await tx<{ id: string }[]>`
      insert into app.users (email, name, slug, timezone, role, import_source, import_ref)
      values (${email}, ${m.name.slice(0, 200)}, ${slug}, ${timezone}, 'user', ${IMPORT_SOURCE}, ${m.uri})
      returning id
    `;
    ctx.usersByEmail.set(email, { id: row.id, timezone, importRef: m.uri });

    if (m.availability?.rules.length) {
      // Override dates are wall dates in the schedule's timezone.
      const today = DateTime.fromJSDate(now).setZone(timezone).toISODate() ?? ctx.today;
      const { weekly, overrides } = mapAvailability(m.availability.rules, today);
      const [schedule] = await tx<{ id: string }[]>`
        insert into app.availability_schedules (owner_user_id, name, timezone, weekly_rules, is_default)
        values (${row.id}, 'Working hours', ${timezone}, ${tx.json(weekly)}, true)
        returning id
      `;
      for (const o of overrides) {
        await tx`
          insert into app.availability_overrides (schedule_id, date, intervals)
          values (${schedule.id}, ${o.date}, ${tx.json(o.intervals)})
          on conflict (schedule_id, date) do nothing
        `;
      }
      ctx.report.users.schedulesImported++;
    } else {
      await tx`
        insert into app.availability_schedules (owner_user_id, name, timezone, is_default)
        values (${row.id}, 'Working hours', ${timezone}, true)
      `;
    }
    await tx`insert into app.user_settings (user_id) values (${row.id}) on conflict do nothing`;
    ctx.users.set(m.uri, { userId: row.id, email, timezone });
    ctx.report.users.created++;
  }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Hosts for a team event type: the listed hosts, plus booked hosts when the list may be incomplete. */
function hostsFor(ctx: Ctx, et: CalendlyEventType): string[] {
  const listed = et.hosts ?? [];
  if (et.hostsComplete !== false && listed.length) return listed;
  return [...new Set([...listed, ...(ctx.bookedHosts.get(et.uri) ?? [])])];
}

async function importTeams(ctx: Ctx, types: CalendlyEventType[]): Promise<void> {
  const { tx } = ctx;
  const byTeam = new Map<string, CalendlyEventType[]>();
  for (const et of types) {
    if (et.profile.type !== "Team") continue;
    byTeam.set(et.profile.owner, [...(byTeam.get(et.profile.owner) ?? []), et]);
  }

  const existingIds = [...byTeam.keys()].map((uri) => ctx.teamsByRef.get(uri)).filter((v): v is string => Boolean(v));
  const existingMembers = existingIds.length
    ? await tx<{ id: string; team_id: string; user_id: string | null }[]>`
        select id, team_id, user_id from app.team_members where team_id = any(${existingIds}::uuid[])`
    : [];
  for (const m of existingMembers) if (m.user_id) ctx.members.set(`${m.team_id}:${m.user_id}`, m.id);

  for (const [teamUri, teamTypes] of byTeam) {
    const name = teamTypes[0].profile.name.slice(0, 200);
    let teamId = ctx.teamsByRef.get(teamUri);
    const isNew = !teamId;
    if (teamId) {
      ctx.report.teams.existing++;
    } else {
      const slug = allocate(ctx.teamSlugs, safeSlug(urlSegments(teamTypes[0].scheduling_url).owner, safeSlug(name, "team")));
      const [row] = await tx<{ id: string }[]>`
        insert into app.teams (name, slug, membership_source, import_source, import_ref)
        values (${name}, ${slug}, 'manual', ${IMPORT_SOURCE}, ${teamUri})
        returning id
      `;
      teamId = row.id;
      ctx.report.teams.created++;
    }
    ctx.teams.set(teamUri, teamId);

    const hostUris = new Set<string>(teamTypes.flatMap((t) => hostsFor(ctx, t)));
    for (const t of teamTypes) {
      const own = hostsFor(ctx, t);
      if (!own.length) {
        ctx.warn(
          hostUris.size
            ? `Team page "${name} / ${t.name}" has no known hosts; it will use the whole team.`
            : `Team page "${name} / ${t.name}" has no known hosts; add team members before it can take bookings.`,
        );
      } else if (t.hostsComplete === false) {
        ctx.warn(`Team page "${name} / ${t.name}": the Calendly host list may be incomplete; hosts include reps seen on its meetings.`);
      }
    }

    for (const hostUri of hostUris) {
      const u = ctx.users.get(hostUri);
      if (!u) {
        ctx.warn(`Team "${name}": host ${hostUri} is not an organization member; skipped.`);
        continue;
      }
      if (ctx.members.has(`${teamId}:${u.userId}`)) continue;
      if (!isNew) {
        // Membership of an existing team is managed in the app; an admin may have removed this rep.
        ctx.warn(`Team "${name}": ${u.email} is a host in Calendly but not a team member here; not re-added.`);
        continue;
      }
      const [row] = await tx<{ id: string }[]>`
        insert into app.team_members (team_id, user_id, email, status, source)
        values (${teamId}, ${u.userId}, ${u.email}, 'active', 'manual')
        on conflict (team_id, email) do update set user_id = excluded.user_id
        returning id
      `;
      ctx.members.set(`${teamId}:${u.userId}`, row.id);
      ctx.report.teamMembers.added++;
    }
  }
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

async function loadExistingQuestions(ctx: Ctx, types: CalendlyEventType[]): Promise<void> {
  const ids = types.map((t) => ctx.eventTypesByRef.get(t.uri)?.id).filter((v): v is string => Boolean(v));
  if (!ids.length) return;
  const rows = await ctx.tx<{ event_type_id: string; key: string; label: Record<string, string> }[]>`
    select event_type_id, key, label from app.event_type_questions where event_type_id = any(${ids}::uuid[])
  `;
  const byType = new Map<string, { key: string; label: Record<string, string> }[]>();
  for (const r of rows) byType.set(r.event_type_id, [...(byType.get(r.event_type_id) ?? []), r]);
  for (const t of types) {
    const existing = ctx.eventTypesByRef.get(t.uri);
    if (!existing) continue;
    const isTeam = t.profile.type === "Team";
    ctx.eventTypes.set(t.uri, {
      id: existing.id,
      language: existing.language,
      teamId: isTeam ? (ctx.teams.get(t.profile.owner) ?? null) : null,
      location: mapLocation(t.locations, existing.language),
      questions: (byType.get(existing.id) ?? []).map((q) => ({ key: q.key, label: pickLocalized(q.label, existing.language) })),
    });
  }
}

async function importEventType(ctx: Ctx, et: CalendlyEventType): Promise<void> {
  const { tx } = ctx;
  if (ctx.eventTypes.has(et.uri)) {
    ctx.report.eventTypes.existing++;
    return;
  }

  const language = languageFor(et.name);
  const location = mapLocation(et.locations, language);
  const questions = mapQuestions(et.custom_questions, location.needsPhone, language);
  const isTeam = et.profile.type === "Team";
  const teamId = isTeam ? (ctx.teams.get(et.profile.owner) ?? null) : null;
  const ownerUserId = isTeam ? null : (ctx.users.get(et.profile.owner)?.userId ?? null);

  if (!teamId && !ownerUserId) {
    ctx.warn(`Event type "${et.name}" (${et.scheduling_url}): owner is not an organization member; skipped.`);
    ctx.report.eventTypes.skipped++;
    return;
  }

  const isGroup = et.kind === "group";
  if (isGroup) ctx.warn(`Event type "${et.name}" (${et.scheduling_url}) is a Calendly group event; group events are not supported, so it will not go live.`);
  const enabledQuestions = (et.custom_questions ?? []).filter((q) => q.enabled).length;
  if (enabledQuestions > LIMITS.questions - (location.needsPhone ? 1 : 0)) {
    ctx.warn(`Event type "${et.name}" (${et.scheduling_url}) has more questions than the editor allows; only the first ${LIMITS.questions} were copied.`);
  }

  // Team pages need hosts that are members here; without any, the page would use the whole team.
  const hostMemberIds = teamId
    ? [...new Set(hostsFor(ctx, et).map((h) => ctx.users.get(h)).map((u) => (u ? ctx.members.get(`${teamId}:${u.userId}`) : undefined)).filter((v): v is string => Boolean(v)))]
    : [];
  const needsHosts = Boolean(teamId) && hostMemberIds.length === 0;
  if (needsHosts) ctx.warn(`Team page "${et.profile.name} / ${et.name}": no Calendly host is a team member here; assign hosts before it can go live.`);

  const { durations, defaultDuration } = durationsFor(et);
  const slugKey = `${teamId ?? ownerUserId}:${language}`;
  const taken = ctx.eventSlugs.get(slugKey) ?? new Set<string>();
  ctx.eventSlugs.set(slugKey, taken);
  const slug = allocate(taken, safeSlug(urlSegments(et.scheduling_url).event ?? et.slug, safeSlug(et.name, "meeting")));
  const description = et.description_plain?.trim() ? { [language]: et.description_plain.trim().slice(0, LIMITS.description) } : {};
  const mode = et.pooling_type ?? "individual";
  // Calendly's flags, kept for the go-live step. Imported pages always start inactive.
  const meta = { active: et.active && !isGroup, secret: et.secret, kind: et.kind ?? "solo", needsHosts };

  const [row] = await tx<{ id: string }[]>`
    insert into app.event_types (
      owner_user_id, team_id, slug, language, name, description, durations, default_duration,
      location_type, location_detail, booking_window_days, scheduling_mode, is_active, is_listed,
      import_source, import_ref, import_meta
    ) values (
      ${ownerUserId}, ${teamId}, ${slug}, ${language}, ${et.name.slice(0, LIMITS.name)}, ${tx.json(description)},
      ${durations}, ${defaultDuration}, ${location.type}, ${location.detail}, 60, ${mode},
      false, ${!et.secret && !isGroup}, ${IMPORT_SOURCE}, ${et.uri}, ${tx.json(meta)}
    )
    returning id
  `;
  if (meta.active && !needsHosts) ctx.report.eventTypes.goLiveEligible++;

  for (const q of questions) {
    await tx`
      insert into app.event_type_questions (event_type_id, key, type, label, options, required, position)
      values (${row.id}, ${q.key}, ${q.type}, ${tx.json({ [language]: q.label })}, ${tx.json(q.options)}, ${q.required}, ${q.position})
    `;
  }

  for (const memberId of hostMemberIds) {
    await tx`
      insert into app.event_type_hosts (event_type_id, team_member_id, is_required)
      values (${row.id}, ${memberId}, true)
      on conflict do nothing
    `;
  }

  ctx.eventTypes.set(et.uri, { id: row.id, language, teamId, location, questions });
  ctx.report.eventTypes.created++;
}

/** Refreshes Calendly's flags on previously imported pages; nothing else about them changes. */
async function refreshImportMeta(ctx: Ctx, types: CalendlyEventType[]): Promise<void> {
  const rows = types
    .filter((et) => ctx.eventTypesByRef.has(et.uri))
    .map((et) => ({ ref: et.uri, meta: { active: et.active && et.kind !== "group", secret: et.secret, kind: et.kind ?? "solo" } }));
  if (!rows.length) return;
  await ctx.tx`
    update app.event_types e
    set import_meta = coalesce(e.import_meta, '{}'::jsonb) || v.meta
    from jsonb_to_recordset(${ctx.tx.json(rows)}) as v(ref text, meta jsonb)
    where e.import_source = ${IMPORT_SOURCE} and e.import_ref = v.ref
      and (coalesce(e.import_meta, '{}'::jsonb) || v.meta) is distinct from e.import_meta
  `;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

async function cancelBooking(tx: Tx, bookingId: string, reason: string): Promise<void> {
  await tx`
    update app.bookings set status = 'cancelled', cancelled_by = 'system', cancelled_at = now(),
      cancel_reason = ${reason}, updated_at = now()
    where id = ${bookingId}
  `;
  await tx`update app.booking_hosts set active = false where booking_id = ${bookingId}`;
}

async function cancelExisting(ctx: Ctx, existing: ExistingBooking): Promise<void> {
  if (existing.status === "cancelled") {
    ctx.report.bookings.unchanged++;
    return;
  }
  await cancelBooking(ctx.tx, existing.id, "Cancelled in Calendly");
  existing.status = "cancelled";
  ctx.report.bookings.cancelled++;
}

async function syncExisting(ctx: Ctx, existing: ExistingBooking, ev: CalendlyEvent): Promise<void> {
  const { tx } = ctx;
  if (existing.status === "cancelled") {
    ctx.report.bookings.unchanged++;
    return;
  }

  const start = new Date(ev.start_time);
  const end = new Date(ev.end_time);
  const timeChanged = existing.start_at.getTime() !== start.getTime() || existing.end_at.getTime() !== end.getTime();

  // A reassignment moves the meeting to a host who is not the current one.
  const resolved = ev.hosts.map((h) => ctx.users.get(h)).filter((u): u is UserRef => Boolean(u));
  const newHost = resolved.length && !resolved.some((u) => u.userId === existing.host_user_id) ? resolved[0] : null;
  if (!resolved.length) ctx.warn(`Meeting ${ev.uri}: its Calendly host is not an organization member; host left unchanged.`);
  // A hold dropped earlier because of an overlap is retried; the overlap may be gone now.
  const retryHold = existing.status === "flagged" && existing.flagged_reason === OVERLAP_REASON && existing.host_active === false;

  if (!timeChanged && !newHost && !retryHold) {
    ctx.report.bookings.unchanged++;
    return;
  }

  const range = blockedRange(ev);
  if (timeChanged) await tx`update app.bookings set start_at = ${start}, end_at = ${end}, updated_at = now() where id = ${existing.id}`;
  const type = ctx.eventTypes.get(ev.event_type);
  const userId = newHost?.userId ?? existing.host_user_id;
  const memberId = newHost ? (type?.teamId ? (ctx.members.get(`${type.teamId}:${newHost.userId}`) ?? null) : null) : undefined;
  const setHost = (db: Tx, active: boolean) =>
    memberId === undefined
      ? db`update app.booking_hosts set user_id = ${userId}, blocked_range = ${range}::tstzrange, active = ${active}
           where booking_id = ${existing.id} and role = 'primary'`
      : db`update app.booking_hosts set user_id = ${userId}, team_member_id = ${memberId}, blocked_range = ${range}::tstzrange, active = ${active}
           where booking_id = ${existing.id} and role = 'primary'`;
  let held = true;
  try {
    await tx.savepoint((sp) => setHost(sp as unknown as Tx, true));
  } catch (err) {
    if ((err as { code?: string }).code !== "23P01") throw err;
    held = false;
    await setHost(tx, false);
  }
  if (!held) {
    if (existing.status !== "flagged") await flagOverlap(tx, existing.id);
    ctx.report.bookings.flagged++;
  } else if (retryHold) {
    await tx`update app.bookings set status = 'confirmed', flagged_reason = null, updated_at = now() where id = ${existing.id}`;
    ctx.report.bookings.restored++;
  }
  if (timeChanged) ctx.report.bookings.updated++;
  if (newHost) ctx.report.bookings.reassigned++;
}

async function importBooking(ctx: Ctx, ev: CalendlyEvent, now: Date): Promise<void> {
  const { tx } = ctx;
  const start = new Date(ev.start_time);
  const end = new Date(ev.end_time);
  // New bookings: copy only meetings that are still on, and only upcoming ones.
  if (isCancelled(ev) || end <= now) {
    ctx.report.bookings.skipped++;
    return;
  }
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

  const loc = mapBookingLocation(ev.location, type.location);
  const answers = (invitee.questions_and_answers ?? []).filter((qa) => qa.answer?.trim());
  const phoneAnswer = answers.find((qa) => answerKey(qa.question, type.questions) === "phone")?.answer ?? null;
  const phone = (invitee.text_reminder_number || loc.inviteePhone || phoneAnswer || null)?.slice(0, 40) ?? null;
  const range = blockedRange(ev);

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
  let held = true;
  try {
    await tx.savepoint(
      (sp) => sp`
        insert into app.booking_hosts (booking_id, user_id, team_member_id, role, blocked_range, active)
        values (${b.id}, ${host.userId}, ${memberId}, 'primary', ${range}::tstzrange, true)
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23P01") throw err;
    held = false;
  }
  if (!held) {
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
  ctx.bookingsByRef.set(ev.uri, {
    id: b.id,
    status: held ? "confirmed" : "flagged",
    start_at: start,
    end_at: end,
    import_ref: ev.uri,
    flagged_reason: held ? null : OVERLAP_REASON,
    host_user_id: host.userId,
    host_active: held,
  });
  ctx.report.bookings.created++;
}

/**
 * Imported bookings inside the snapshot's window that Calendly no longer lists. A snapshot that
 * would cancel an unusually large share of them is refused when applying: it is more likely
 * an incomplete pull than a wave of cancellations.
 */
async function cancelMissing(ctx: Ctx, snap: CalendlySnapshot, events: CalendlyEvent[], apply: boolean): Promise<void> {
  const from = new Date(snap.eventsWindow.from).getTime();
  const to = new Date(snap.eventsWindow.to).getTime();
  const listed = new Set(events.map((e) => e.uri));
  const inWindow = [...ctx.bookingsByRef.values()].filter((b) => {
    const start = b.start_at.getTime();
    return b.status !== "cancelled" && start >= from && start < to;
  });
  const missing = inWindow.filter((b) => !listed.has(b.import_ref));
  if (missing.length > MISSING_FLOOR && missing.length > inWindow.length * MISSING_SHARE_LIMIT) {
    const msg = `${missing.length} of ${inWindow.length} imported bookings in the window are missing from this snapshot. That looks like an incomplete pull.`;
    if (apply) throw new ImportRefusedError(`${msg} Nothing was saved.`);
    ctx.warn(`${msg} Applying it will be refused.`);
  }
  for (const b of missing) {
    await cancelBooking(ctx.tx, b.id, "No longer listed in Calendly");
    b.status = "cancelled";
    ctx.report.bookings.cancelledMissing++;
  }
}

async function flagOverlap(tx: Tx, bookingId: string): Promise<void> {
  await tx`
    update app.bookings set status = 'flagged', flagged_reason = ${OVERLAP_REASON}
    where id = ${bookingId}
  `;
}
