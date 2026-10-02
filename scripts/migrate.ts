/**
 * Applies SQL migrations in supabase/migrations to DATABASE_URL, in filename order,
 * recording each in app_migrations. Safe to re-run. Usage: pnpm db:migrate
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`create table if not exists public.app_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from public.app_migrations`).map((r) => r.name));
  const dir = path.resolve(__dirname, "../supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    process.stdout.write(`applying ${file} ... `);
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(path.join(dir, file), "utf8"));
      await tx`insert into public.app_migrations (name) values (${file})`;
    });
    console.log("ok");
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
