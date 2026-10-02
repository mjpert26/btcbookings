import "server-only";
import postgres from "postgres";
import { env } from "@/server/env";

/**
 * Database access.
 *
 * - `withUser(userId, fn)` runs `fn` in a transaction as the RLS-restricted `app_user`
 *   role with the user's id in `request.jwt.claims`. Use it for every request made on
 *   behalf of a signed-in employee.
 * - `service()` returns the owner connection, which bypasses RLS. Only modules under
 *   src/server that act for no signed-in user (webhooks, cron jobs, the public booking
 *   engine, sign-in itself) may use it.
 */
export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

declare global {
  var __btcSql: Sql | undefined;
}

function createClient(url: string, max: number): Sql {
  const client = postgres(url, {
    max,
    // Supabase's transaction pooler does not support prepared statements.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      // Return bigint columns as numbers; counters stay far below 2^53.
      bigint: {
        to: 20,
        from: [20],
        parse: (v: string): unknown => Number(v),
        serialize: (v: unknown) => String(v),
      },
    },
    transform: { undefined: null },
    onnotice: () => {},
  });
  return client as unknown as Sql;
}

export function service(): Sql {
  if (!globalThis.__btcSql) {
    const e = env();
    globalThis.__btcSql = createClient(e.DATABASE_URL, e.DATABASE_POOL_MAX);
  }
  return globalThis.__btcSql;
}

/** For tests: replace the connection (e.g. pointing at the local test database). */
export function setServiceClient(sql: Sql | undefined): void {
  globalThis.__btcSql = sql;
}

export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: "app_user" });
  return (await service().begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`set local role app_user`;
    return fn(tx);
  })) as T;
}

export async function serviceTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await service().begin(fn)) as T;
}
