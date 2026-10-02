/**
 * Seeds demo data for local development: users, a queue-linked team and a manual team,
 * individual, round-robin and collective event types, an English event with a Spanish
 * variant routed to a different pool, and sample bookings.
 *
 * Usage: pnpm seed            (DATABASE_URL from .env.local / environment)
 * Refuses to run against a non-local database unless --allow-remote is passed.
 * Re-running replaces the demo rows (matched by the @demo.bigthinkcapital.com domain).
 */
import { config } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const DEMO_DOMAIN = "demo.bigthinkcapital.com";
const ZONE = "America/New_York";

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!local && !process.argv.includes("--allow-remote")) {
    throw new Error(`Refusing to seed non-local database host ${host}. Pass --allow-remote to override.`);
  }
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  assertLocal(url);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  await sql.begin(async (tx) => {
    // Clean previous demo data.
    const old = await tx<{ id: string }[]>`select id from app.users where email like ${"%@" + DEMO_DOMAIN}`;
    const oldIds = old.map((r) => r.id);
    if (oldIds.length) {
      await tx`delete from app.bookings where event_type_id in (select id from app.event_types where owner_user_id = any(${oldIds}))`;
    }
    await tx`delete from app.bookings where event_type_id in (select e.id from app.event_types e join app.teams t on t.id = e.team_id where t.slug like 'demo-%')`;
    await tx`delete from app.teams where slug like 'demo-%'`;
    await tx`delete from app.event_types where owner_user_id = any(${oldIds})`;
    await tx`delete from app.users where email like ${"%@" + DEMO_DOMAIN}`;

    // Users
    const people = [
      { key: "mike", name: "Mike Demo", role: "admin", languages: ["en"] },
      { key: "ana", name: "Ana Rivera", role: "user", languages: ["en", "es"] },
      { key: "luis", name: "Luis Gómez", role: "user", languages: ["en", "es"] },
      { key: "sam", name: "Sam Carter", role: "user", languages: ["en"] },
      { key: "jordan", name: "Jordan Lee", role: "user", languages: ["en"] },
      { key: "taylor", name: "Taylor Brooks", role: "user", languages: ["en"] },
    ] as const;
    const users: Record<string, string> = {};
    for (const p of people) {
      const [u] = await tx<{ id: string }[]>`
        insert into app.users (email, name, slug, role, languages, timezone)
        values (${`${p.key}@${DEMO_DOMAIN}`}, ${p.name}, ${`demo-${p.key}`}, ${p.role}, ${p.languages as unknown as string[]}, ${ZONE})
        returning id`;
      users[p.key] = u.id;
      await tx`insert into app.availability_schedules (owner_user_id, name, timezone, is_default) values (${u.id}, 'Working hours', ${ZONE}, true)`;
      await tx`insert into app.user_settings (user_id) values (${u.id})`;
      // Taylor's Outlook connection is broken, to show the round-robin skip.
      await tx`insert into app.calendar_connections (user_id, status, last_error, broken_at)
               values (${u.id}, ${p.key === "taylor" ? "broken" : "healthy"},
                       ${p.key === "taylor" ? "Token endpoint error invalid_grant (demo)" : null},
                       ${p.key === "taylor" ? new Date() : null})`;
    }

    // Teams
    const [sdr] = await tx<{ id: string }[]>`
      insert into app.teams (name, slug, description, membership_source, last_synced_at, sync_health)
      values ('SDR Round Robin (demo)', 'demo-sdr', 'Queue-linked demo team', 'salesforce_queue', now(), 'ok') returning id`;
    const [partners] = await tx<{ id: string }[]>`
      insert into app.teams (name, slug, description, membership_source)
      values ('Partner Success (demo)', 'demo-partners', 'Manual demo team', 'manual') returning id`;
    await tx`insert into app.team_sf_queues (team_id, queue_id, queue_name) values (${sdr.id}, '00GVy00000TRvHdMAL', 'SDR Round Robin')`;
    await tx`insert into app.team_admins (team_id, user_id) values (${sdr.id}, ${users.mike}), (${partners.id}, ${users.mike})`;

    const member = async (teamId: string, key: string, over: { status?: string; source?: string; weight?: number; tier?: number; count?: number } = {}) => {
      const [m] = await tx<{ id: string }[]>`
        insert into app.team_members (team_id, user_id, email, status, source, weight, priority_tier, rr_assignment_count, rr_last_assigned_at)
        values (${teamId}, ${users[key] ?? null}, ${`${key}@${DEMO_DOMAIN}`}, ${over.status ?? "active"}, ${over.source ?? "queue"},
                ${over.weight ?? 1}, ${over.tier ?? 1}, ${over.count ?? 0}, ${over.count ? DateTime.now().minus({ days: over.count }).toJSDate() : null})
        returning id`;
      return m.id;
    };
    const mAna = await member(sdr.id, "ana", { count: 3 });
    const mLuis = await member(sdr.id, "luis", { count: 2 });
    const mSam = await member(sdr.id, "sam", { count: 4 });
    await member(sdr.id, "jordan", { status: "paused", count: 5 }); // removed from the queue
    await member(sdr.id, "taylor", { count: 1 }); // broken Outlook connection
    // Queue member who has never signed in.
    await tx`insert into app.team_members (team_id, email, status, source) values (${sdr.id}, ${"newhire@" + DEMO_DOMAIN}, 'pending_onboarding', 'queue')`;
    const pSam = await member(partners.id, "sam", { source: "manual" });
    const pJordan = await member(partners.id, "jordan", { source: "manual" });

    await tx`insert into app.membership_events (team_id, email, old_status, new_status, source, detail)
             values (${sdr.id}, ${"jordan@" + DEMO_DOMAIN}, 'active', 'paused', 'poll', '{"reason":"removed_from_queue"}')`;

    await tx`insert into app.team_slack_channels (team_id, channel_id, channel_name, mode, dry_run)
             values (${sdr.id}, 'C0DEMO0001', 'sdr-team', 'add_and_remove', true)`;

    // Event types
    const [intro] = await tx<{ id: string }[]>`
      insert into app.event_types (owner_user_id, slug, name, description, durations, default_duration, location_type, buffer_after_min)
      values (${users.mike}, 'intro-call', 'Intro call', ${tx.json({ en: "A 30-minute introduction to Big Think Capital financing options." })},
              '{15,30}', 30, 'teams', 10)
      returning id`;
    await tx`insert into app.event_type_questions (event_type_id, key, type, label, required, position) values
      (${intro.id}, 'company', 'text', ${tx.json({ en: "Business name", es: "Nombre del negocio" })}, true, 0)`;

    const [consult] = await tx<{ id: string }[]>`
      insert into app.event_types (team_id, slug, name, description, durations, default_duration, location_type,
                                   scheduling_mode, rr_strategy, rr_sticky_returning_invitee, min_notice_min)
      values (${sdr.id}, 'funding-consultation', 'Funding consultation',
              ${tx.json({ en: "Talk with a funding specialist about your business.", es: "Hable con un especialista en financiamiento sobre su negocio." })},
              '{30}', 30, 'teams', 'round_robin', 'fairness', true, 120)
      returning id`;
    await tx`insert into app.event_type_questions (event_type_id, key, type, label, options, required, position) values
      (${consult.id}, 'company', 'text', ${tx.json({ en: "Business name", es: "Nombre del negocio" })}, '[]', true, 0),
      (${consult.id}, 'monthly_revenue', 'dropdown', ${tx.json({ en: "Monthly revenue", es: "Ingresos mensuales" })},
        ${tx.json([
          { value: "lt_10k", label: { en: "Under $10k", es: "Menos de $10k" } },
          { value: "10k_50k", label: { en: "$10k - $50k", es: "$10k - $50k" } },
          { value: "gt_50k", label: { en: "Over $50k", es: "Más de $50k" } },
        ])}, true, 1),
      (${consult.id}, 'notes', 'textarea', ${tx.json({ en: "Anything we should know?", es: "¿Algo que debamos saber?" })}, '[]', false, 2)`;
    await tx`insert into app.event_type_sf_settings (event_type_id, create_sf_lead, field_mapping, static_values, owner_mode, set_meeting_booked_fields)
             values (${consult.id}, true,
                     ${tx.json({ invitee_email: "Email", invitee_phone: "Phone", "q:company": "Company", language_name: "Customers_Preferred_Language__c" })},
                     ${tx.json({ csbs__ISO__c: "001000000000000AAA", LeadSource: "Web" })}, 'assigned_host', true)`;

    // Spanish variant: inherits questions and Salesforce settings, routes to Spanish speakers only.
    const [consultEs] = await tx<{ id: string }[]>`
      insert into app.event_types (team_id, slug, language, parent_event_type_id, name, durations, default_duration,
                                   location_type, scheduling_mode, rr_strategy, min_notice_min)
      values (${sdr.id}, 'funding-consultation', 'es', ${consult.id}, 'Consulta de financiamiento', '{30}', 30, 'teams',
              'round_robin', 'fairness', 120)
      returning id`;
    await tx`insert into app.event_type_hosts (event_type_id, team_member_id) values (${consultEs.id}, ${mAna}), (${consultEs.id}, ${mLuis})`;

    const [review] = await tx<{ id: string }[]>`
      insert into app.event_types (team_id, slug, name, durations, default_duration, location_type, scheduling_mode)
      values (${partners.id}, 'partner-review', 'Partner review', '{45}', 45, 'teams', 'collective') returning id`;
    await tx`insert into app.event_type_hosts (event_type_id, team_member_id, is_required) values (${review.id}, ${pSam}, true), (${review.id}, ${pJordan}, true)`;

    // Busy time from "Outlook".
    const day = (n: number) => DateTime.now().setZone(ZONE).plus({ days: n }).startOf("day");
    await tx`insert into app.busy_blocks (user_id, graph_event_id, start_at, end_at, show_as) values
      (${users.ana}, 'demo-busy-1', ${day(1).set({ hour: 10 }).toJSDate()}, ${day(1).set({ hour: 12 }).toJSDate()}, 'busy'),
      (${users.sam}, 'demo-busy-2', ${day(1).set({ hour: 13 }).toJSDate()}, ${day(1).set({ hour: 14 }).toJSDate()}, 'oof'),
      (${users.luis}, 'demo-busy-3', ${day(2).set({ hour: 9, minute: 30 }).toJSDate()}, ${day(2).set({ hour: 11 }).toJSDate()}, 'tentative')`;

    // Bookings
    const book = async (eventTypeId: string, hostId: string, memberId: string | null, start: DateTime, minutes: number,
      invitee: { name: string; email: string; lang?: string }, status = "confirmed") => {
      const token = randomBytes(32).toString("base64url");
      const end = start.plus({ minutes });
      const [b] = await tx<{ id: string }[]>`
        insert into app.bookings (event_type_id, language, status, start_at, end_at, invitee_name, invitee_email, invitee_timezone,
                                  location_type, manage_token_hash)
        values (${eventTypeId}, ${invitee.lang ?? "en"}, ${status}, ${start.toJSDate()}, ${end.toJSDate()}, ${invitee.name}, ${invitee.email},
                ${ZONE}, 'teams', ${sha256(token)})
        returning id`;
      await tx`insert into app.booking_hosts (booking_id, user_id, team_member_id, blocked_range, active)
               values (${b.id}, ${hostId}, ${memberId}, tstzrange(${start.toJSDate()}, ${end.toJSDate()}, '[)'), ${status === "confirmed"})`;
      await tx`insert into app.booking_answers (booking_id, question_key, value) values (${b.id}, 'company', ${invitee.name.split(" ")[1] + " LLC"})`;
      return { id: b.id, token };
    };
    const created = [
      await book(intro.id, users.mike, null, day(1).set({ hour: 15 }), 30, { name: "Pat Merchant", email: "pat@example.com" }),
      await book(consult.id, users.ana, mAna, day(2).set({ hour: 14 }), 30, { name: "Chris Owner", email: "chris@example.com" }),
      await book(consult.id, users.sam, mSam, day(3).set({ hour: 11 }), 30, { name: "Dana Shop", email: "dana@example.com" }),
      await book(consultEs.id, users.luis, mLuis, day(2).set({ hour: 16 }), 30, { name: "María López", email: "maria@example.com", lang: "es" }),
      await book(consult.id, users.ana, mAna, day(-3).set({ hour: 10 }), 30, { name: "Eli Past", email: "eli@example.com" }),
      await book(intro.id, users.mike, null, day(4).set({ hour: 10 }), 30, { name: "Casey Cancel", email: "casey@example.com" }, "cancelled"),
    ];

    console.log("Seeded demo data.");
    console.log("Public pages:");
    console.log("  /demo-mike, /demo-mike/intro-call");
    console.log("  /t/demo-sdr/funding-consultation (and /es), /t/demo-partners/partner-review");
    console.log("Manage link for the first booking: /b/" + created[0].token);
  });
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
