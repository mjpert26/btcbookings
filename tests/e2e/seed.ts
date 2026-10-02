import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

/**
 * Recreates the e2e database from the migrations and seeds demo booking data:
 * - Dana Rivera (/dana-rivera): "intro-call" (30 or 60 min) with a Spanish variant.
 * - Sales team (/t/sales): round-robin "consultation" for Alex and Bea, and a Spanish
 *   variant routed to Carlos. Salesforce lead creation is on for the parent.
 * Standalone on purpose: it does not import app modules (they are server-only).
 */
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/btc_e2e_booking";

const WEEKDAYS = { start: "09:00", end: "18:00" };
const RULES = {
  mon: [WEEKDAYS],
  tue: [WEEKDAYS],
  wed: [WEEKDAYS],
  thu: [WEEKDAYS],
  fri: [WEEKDAYS],
  sat: [WEEKDAYS],
  sun: [WEEKDAYS],
};

export async function seedE2E(url = E2E_DATABASE_URL): Promise<void> {
  const admin = new URL(url);
  const dbName = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const root = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await root.unsafe(`drop database if exists ${dbName} with (force)`);
  await root.unsafe(`create database ${dbName}`);
  await root.end();

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(path.join(dir, file), "utf8"));
  }

  async function user(name: string, slug: string, email: string) {
    const [u] = await sql<{ id: string }[]>`
      insert into app.users (email, name, slug, timezone, languages)
      values (${email}, ${name}, ${slug}, 'America/New_York', '{en,es}') returning id
    `;
    await sql`insert into app.calendar_connections (user_id, status) values (${u.id}, 'healthy')`;
    await sql`insert into app.user_settings (user_id) values (${u.id})`;
    await sql`
      insert into app.availability_schedules (owner_user_id, timezone, weekly_rules, is_default)
      values (${u.id}, 'America/New_York', ${sql.json(RULES)}, true)
    `;
    return u.id;
  }

  const dana = await user("Dana Rivera", "dana-rivera", "dana.rivera@bigthinkcapital.com");
  const alex = await user("Alex Morgan", "alex-morgan", "alex.morgan@bigthinkcapital.com");
  const bea = await user("Bea Santos", "bea-santos", "bea.santos@bigthinkcapital.com");
  const carlos = await user("Carlos Mendez", "carlos-mendez", "carlos.mendez@bigthinkcapital.com");

  const description = {
    en: "A short call to understand your business and the funding options that fit.",
    es: "Una llamada breve para conocer su negocio y las opciones de financiamiento adecuadas.",
  };
  const [intro] = await sql<{ id: string }[]>`
    insert into app.event_types (owner_user_id, slug, language, name, description, durations, default_duration,
                                 min_notice_min, booking_window_days, scheduling_mode)
    values (${dana}, 'intro-call', 'en', 'Intro call', ${sql.json(description)}, '{30,60}', 30, 60, 30, 'individual')
    returning id
  `;
  await sql`
    insert into app.event_types (owner_user_id, slug, language, parent_event_type_id, name, min_notice_min, scheduling_mode)
    values (${dana}, 'intro-call', 'es', ${intro.id}, 'Llamada inicial', 60, 'individual')
  `;
  await sql`
    insert into app.event_type_questions (event_type_id, key, type, label, options, required, position) values
    (${intro.id}, 'company', 'text', ${sql.json({ en: "Company name", es: "Nombre de la empresa" })}, '[]', true, 1),
    (${intro.id}, 'funding', 'dropdown', ${sql.json({ en: "Funding needed", es: "Financiamiento requerido" })},
      ${sql.json([
        { value: "under_50k", label: { en: "Under $50,000", es: "Menos de $50,000" } },
        { value: "50k_250k", label: { en: "$50,000 to $250,000", es: "De $50,000 a $250,000" } },
        { value: "over_250k", label: { en: "Over $250,000", es: "Más de $250,000" } },
      ])}, false, 2)
  `;

  const [team] = await sql<{ id: string }[]>`
    insert into app.teams (name, slug, description) values ('Funding Specialists', 'sales', 'Talk with a Big Think Capital funding specialist.')
    returning id
  `;
  const members: Record<string, string> = {};
  for (const [id, email] of [
    [alex, "alex.morgan@bigthinkcapital.com"],
    [bea, "bea.santos@bigthinkcapital.com"],
    [carlos, "carlos.mendez@bigthinkcapital.com"],
  ]) {
    const [m] = await sql<{ id: string }[]>`
      insert into app.team_members (team_id, user_id, email) values (${team.id}, ${id}, ${email}) returning id
    `;
    members[id] = m.id;
  }
  const [consult] = await sql<{ id: string }[]>`
    insert into app.event_types (team_id, slug, language, name, description, durations, default_duration,
                                 min_notice_min, scheduling_mode, rr_strategy)
    values (${team.id}, 'consultation', 'en', 'Funding consultation', ${sql.json(description)}, '{30}', 30, 60, 'round_robin', 'fairness')
    returning id
  `;
  const [consultEs] = await sql<{ id: string }[]>`
    insert into app.event_types (team_id, slug, language, parent_event_type_id, name, min_notice_min, scheduling_mode)
    values (${team.id}, 'consultation', 'es', ${consult.id}, 'Consulta de financiamiento', 60, 'round_robin')
    returning id
  `;
  await sql`insert into app.event_type_hosts (event_type_id, team_member_id) values (${consult.id}, ${members[alex]}), (${consult.id}, ${members[bea]})`;
  await sql`insert into app.event_type_hosts (event_type_id, team_member_id) values (${consultEs.id}, ${members[carlos]})`;
  await sql`insert into app.event_type_sf_settings (event_type_id, create_sf_lead) values (${consult.id}, true)`;
  await sql.end();
}

if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  seedE2E().then(
    () => console.log(`Seeded ${E2E_DATABASE_URL}`),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
