import postgres from "postgres";
import { setServiceClient, type Sql } from "@/server/db/client";

/** Connects the app's service client to the test database. Call in beforeAll. */
export function connectTestDb(max = 10): Sql {
  const sql = postgres(process.env.DATABASE_URL!, {
    max,
    prepare: false,
    onnotice: () => {},
    transform: { undefined: null },
    types: { bigint: { to: 20, from: [20], parse: (v: string) => Number(v), serialize: (v: number) => String(v) } },
  }) as unknown as Sql;
  setServiceClient(sql);
  return sql;
}

/** Removes all rows from app tables (keeps admin seeds). Call in beforeEach for isolation. */
export async function truncateAll(sql: Sql): Promise<void> {
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'app' and tablename <> 'admin_seeds'
  `;
  await sql.unsafe(`truncate ${rows.map((r) => `app.${r.tablename}`).join(", ")} restart identity cascade`);
}

let counter = 0;
export async function makeUser(
  sql: Sql,
  over: Partial<{ email: string; name: string; role: "user" | "admin"; timezone: string; calendar: "healthy" | "broken" | null }> = {},
): Promise<{ id: string; email: string }> {
  counter++;
  const email = over.email ?? `user${counter}-${Date.now()}@bigthinkcapital.com`;
  const [u] = await sql<{ id: string }[]>`
    insert into app.users (email, name, slug, role, timezone)
    values (${email}, ${over.name ?? `User ${counter}`}, ${`user-${counter}-${Math.random().toString(36).slice(2, 8)}`},
            ${over.role ?? "user"}, ${over.timezone ?? "America/New_York"})
    returning id
  `;
  if (over.calendar !== null) {
    await sql`insert into app.calendar_connections (user_id, status) values (${u.id}, ${over.calendar ?? "healthy"})`;
  }
  return { id: u.id, email };
}
