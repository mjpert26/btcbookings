import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

/**
 * Recreates the integration test database from the migrations once per test run.
 * Requires a local Postgres 16+ with btree_gist, citext and pgcrypto (scripts/local-db.sh).
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/btc_scheduler_test";
  const admin = new URL(url);
  const dbName = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  try {
    execFileSync(path.resolve(__dirname, "../../scripts/local-db.sh"), ["start"], { stdio: "ignore" });
  } catch {
    // Assume an externally managed database when the script cannot start one.
  }
  const root = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await root.unsafe(`drop database if exists ${dbName} with (force)`);
  await root.unsafe(`create database ${dbName}`);
  await root.end();

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(path.join(dir, file), "utf8"));
  }
  await sql.end();
}
