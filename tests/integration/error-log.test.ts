import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { withUser, type Sql } from "@/server/db/client";
import { logError } from "@/server/errors/log";
import { listErrors, purgeErrorLog, setErrorResolved } from "@/server/errors/admin";
import { logRequestError } from "@/server/errors/request";
import { executeJob } from "@/server/jobs/worker";
import { PermanentJobError, type JobRow } from "@/server/jobs/types";

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
});

type Row = { id: string; fingerprint: string; occurrences: number; message: string; route: string | null; resolved_at: Date | null; context: Record<string, unknown>; first_seen_at: Date; last_seen_at: Date };
const rows = () => sql<Row[]>`select * from app.error_log order by first_seen_at, id`;

describe("logError", () => {
  it("increments the count for repeats instead of inserting", async () => {
    await logError(new Error("Graph timeout after 31 ms"), { source: "job", route: "graph_event_create" });
    await logError(new Error("Graph timeout after 4500 ms"), { source: "job", route: "graph_event_create" });
    await logError(new Error("Graph timeout after 12 ms"), { source: "job", route: "graph_event_delete" });
    const all = await rows();
    expect(all).toHaveLength(2);
    const create = all.find((r) => r.route === "graph_event_create")!;
    expect(create.occurrences).toBe(2);
    expect(create.message).toBe("Graph timeout after 4500 ms");
    expect(create.last_seen_at.getTime()).toBeGreaterThanOrEqual(create.first_seen_at.getTime());
  });

  it("stores sanitized messages, routes and context", async () => {
    await logError(new Error("lookup failed for jane@example.com using Bearer abcdef123456"), {
      source: "api",
      route: "/api/v1/bookings/0b7e6c1a-2f7d-4d8e-9a51-3c2b1d0e9f8a?token=abc",
      method: "get",
      context: { bookingId: "b1", authorization: "Bearer zzz", body: { email: "x@y.com" } },
    });
    const [r] = await sql`select message, route, method, context, stack from app.error_log`;
    expect(r.message).toBe("lookup failed for [email] using Bearer [redacted]");
    expect(r.route).toBe("/api/v1/bookings/:id");
    expect(r.method).toBe("GET");
    expect(r.context).toEqual({ bookingId: "b1", authorization: "[redacted]", body: "[redacted]" });
    expect(JSON.stringify(r)).not.toContain("jane@");
  });

  it("never throws, even when the database write fails", async () => {
    const broken = (() => {
      throw new Error("connection refused");
    }) as unknown as Sql;
    const original = console.error;
    const messages: string[] = [];
    console.error = (m: string) => void messages.push(m);
    try {
      await expect(logError(new Error("x"), { source: "page", db: broken })).resolves.toBeUndefined();
      await expect(logError(new Error("x"), { source: "not-a-source" as never })).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(messages.length).toBe(2);
    expect(messages.join(" ")).not.toContain("connection refused");
    expect(await rows()).toHaveLength(0);
  });

  it("ignores Next.js redirect and not-found signals", async () => {
    await logError(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }), { source: "page" });
    expect(await rows()).toHaveLength(0);
  });

  it("records request errors with the route pattern, not the path", async () => {
    await logRequestError(
      Object.assign(new Error("render failed"), { digest: "998877" }),
      { path: "/b/SecretManageToken123456789/manage?x=1", method: "GET", headers: { cookie: "btc_session=abc" } },
      { routerKind: "App Router", routePath: "/(public)/b/[token]/manage/page", routeType: "render", renderSource: "react-server-components", revalidateReason: undefined },
    );
    const [r] = await sql`select source, route, digest, context from app.error_log`;
    expect(r).toMatchObject({ source: "page", route: "/(public)/b/[token]/manage/page", digest: "998877" });
    expect(JSON.stringify(r)).not.toContain("SecretManageToken");
    expect(JSON.stringify(r)).not.toContain("btc_session");
  });
});

describe("job worker hook", () => {
  const job = (over: Partial<JobRow> = {}): JobRow => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "test_kind",
    payload: { email: "invitee@example.com", secretNote: "do not log" },
    attempts: 1,
    max_attempts: 3,
    idempotency_key: null,
    booking_id: null,
    team_id: null,
    ...over,
  });

  it("logs retried and dead attempts with the job kind and no payload", async () => {
    const [j] = await sql<{ id: string }[]>`
      insert into app.jobs (kind, payload, max_attempts) values ('test_kind', ${sql.json({ email: "invitee@example.com" })}, 3) returning id
    `;
    const failing = { test_kind: async () => { throw new Error("upstream returned 502"); } };
    expect(await executeJob(sql, failing, job({ id: j.id, attempts: 1 }))).toBe("retried");
    expect(await executeJob(sql, failing, job({ id: j.id, attempts: 3 }))).toBe("dead");
    const permanent = { test_kind: async () => { throw new PermanentJobError("bad input 7"); } };
    expect(await executeJob(sql, permanent, job({ id: j.id, attempts: 1 }))).toBe("dead");

    const all = await rows();
    expect(all).toHaveLength(2);
    const upstream = all.find((r) => r.message === "upstream returned 502")!;
    expect(upstream).toMatchObject({ route: "test_kind", occurrences: 2 });
    expect(upstream.context).toMatchObject({ jobKind: "test_kind", attempt: 3, maxAttempts: 3, outcome: "dead" });
    expect(JSON.stringify(all)).not.toContain("invitee@example.com");
    expect(JSON.stringify(all)).not.toContain("do not log");
  });

  it("logs jobs with no handler", async () => {
    const [j] = await sql<{ id: string }[]>`insert into app.jobs (kind, payload) values ('missing_kind', '{}') returning id`;
    expect(await executeJob(sql, {}, job({ id: j.id, kind: "missing_kind" }))).toBe("unknownKind");
    const [r] = await rows();
    expect(r).toMatchObject({ route: "missing_kind", message: "No handler for kind missing_kind" });
  });
});

describe("resolve and reopen", () => {
  it("resolves with an audit entry, then opens a new entry on the next occurrence", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    await logError(new Error("boom"), { source: "action", route: "/admin/users" });
    const [first] = await rows();

    const res = await withUser(admin.id, (tx) => setErrorResolved(tx, admin.id, first.id, true));
    expect(res).toEqual({ ok: true, changed: true });
    const [resolved] = await sql`select resolved_at, resolved_by from app.error_log where id = ${first.id}`;
    expect(resolved.resolved_at).not.toBeNull();
    expect(resolved.resolved_by).toBe(admin.id);
    const [audit] = await sql`select action, entity_type, entity_id, before, after, actor_user_id from app.audit_log`;
    expect(audit).toMatchObject({ action: "error.resolve", entity_type: "error_log", entity_id: first.id, actor_user_id: admin.id });
    expect(audit.before).toEqual({ resolvedAt: null, resolvedBy: null });
    expect(audit.after).toMatchObject({ resolvedBy: admin.id });

    // Resolving again changes nothing and writes no audit entry.
    expect(await withUser(admin.id, (tx) => setErrorResolved(tx, admin.id, first.id, true))).toEqual({ ok: true, changed: false });

    await logError(new Error("boom"), { source: "action", route: "/admin/users" });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ occurrences: 1, resolved_at: null });

    // Reopening the old entry is refused while the newer one is open.
    const refused = await withUser(admin.id, (tx) => setErrorResolved(tx, admin.id, first.id, false));
    expect(refused.ok).toBe(false);

    await withUser(admin.id, (tx) => setErrorResolved(tx, admin.id, all[1].id, true));
    expect(await withUser(admin.id, (tx) => setErrorResolved(tx, admin.id, first.id, false))).toEqual({ ok: true, changed: true });
    const actions = await sql<{ action: string }[]>`select action from app.audit_log order by created_at, id`;
    expect(actions.map((a) => a.action).sort()).toEqual(["error.reopen", "error.resolve", "error.resolve"]);

    const listed = await withUser(admin.id, (tx) => listErrors(tx, { status: "unresolved", limit: 10, offset: 0 }));
    expect(listed.map((r) => r.id)).toEqual([first.id]);
    const resolvedList = await withUser(admin.id, (tx) => listErrors(tx, { status: "resolved", source: "action", limit: 10, offset: 0 }));
    expect(resolvedList.map((r) => r.id)).toEqual([all[1].id]);
    expect(resolvedList[0].resolved_by_name).not.toBeNull();
  });
});

describe("row-level security", () => {
  it("lets admins read and update, and nobody else", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const agent = await makeUser(sql);
    const manager = await makeUser(sql);
    await sql`update app.users set role = 'manager' where id = ${manager.id}`;
    await logError(new Error("secret failure"), { source: "page", route: "/dashboard" });
    const [entry] = await rows();

    for (const u of [agent, manager]) {
      const visible = await withUser(u.id, (tx) => tx`select id from app.error_log`);
      expect(visible).toHaveLength(0);
      const res = await withUser(u.id, (tx) => setErrorResolved(tx, u.id, entry.id, true));
      expect(res.ok).toBe(false);
      const updated = await withUser(u.id, (tx) => tx`update app.error_log set resolved_at = now() where id = ${entry.id} returning id`);
      expect(updated).toHaveLength(0);
    }
    expect((await rows())[0].resolved_at).toBeNull();

    const adminVisible = await withUser(admin.id, (tx) => tx`select id from app.error_log`);
    expect(adminVisible).toHaveLength(1);

    // Inserts and deletes are reserved for the service connection, even for admins.
    await expect(
      withUser(admin.id, (tx) => tx`insert into app.error_log (fingerprint, source, error_name, message) values (${"a".repeat(64)}, 'page', 'Error', 'x')`),
    ).rejects.toThrow(/permission denied/);
    await expect(withUser(admin.id, (tx) => tx`delete from app.error_log`)).rejects.toThrow(/permission denied/);
    await expect(withUser(admin.id, (tx) => tx`update app.error_log set message = 'changed'`)).rejects.toThrow(/permission denied/);
  });
});

describe("retention", () => {
  it("purges resolved entries after 90 days and all entries after 180 days", async () => {
    const insert = (fp: string, lastSeenDaysAgo: number, resolvedDaysAgo: number | null) => sql`
      insert into app.error_log (fingerprint, source, error_name, message, first_seen_at, last_seen_at, resolved_at)
      values (${fp.repeat(64)}, 'job', 'Error', ${fp}, now() - make_interval(days => ${lastSeenDaysAgo + 1}),
              now() - make_interval(days => ${lastSeenDaysAgo}),
              ${resolvedDaysAgo === null ? null : sql`now() - make_interval(days => ${resolvedDaysAgo})`})
    `;
    await insert("a", 100, 95); // resolved more than 90 days ago: purged
    await insert("b", 100, 30); // resolved recently: kept
    await insert("c", 200, null); // unresolved but not seen for 180 days: purged
    await insert("d", 10, null); // recent and open: kept
    expect(await purgeErrorLog(sql)).toEqual({ deleted: 2 });
    const left = await sql<{ message: string }[]>`select message from app.error_log order by message`;
    expect(left.map((r) => r.message)).toEqual(["b", "d"]);
  });
});
