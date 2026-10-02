import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import type { Sql } from "@/server/db/client";
import { completeLogin, LoginRejected } from "@/server/auth/login";
import { getGraphAccessToken, CalendarConnectionBroken } from "@/server/graph/tokens";
import { TokenError, type TokenSet } from "@/server/auth/entra";
import { decryptSecret, encryptSecret } from "@/server/crypto/aes";
import { enqueue } from "@/server/jobs/queue";
import { runJobs } from "@/server/jobs/worker";
import { PermanentJobError } from "@/server/jobs/types";

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

const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: "access-1",
  refreshToken: "refresh-1",
  idToken: "id",
  expiresAt: new Date(Date.now() + 3600_000),
  scopes: ["Calendars.ReadWrite"],
  ...over,
});
const claims = (email: string, oid = "oid-" + email) => ({ oid, tid: "t", email, name: "Mike Perticone", preferredUsername: email });

describe("first login", () => {
  it("creates the user, default schedule, settings and encrypted tokens", async () => {
    const id = await completeLogin(claims("someone@bigthinkcapital.com"), tokens());
    const [u] = await sql`select slug, role, timezone from app.users where id = ${id}`;
    expect(u).toMatchObject({ slug: "mike-perticone", role: "user", timezone: "America/New_York" });
    const [sched] = await sql`select weekly_rules, is_default from app.availability_schedules where owner_user_id = ${id}`;
    expect(sched.is_default).toBe(true);
    expect(sched.weekly_rules.mon).toEqual([{ start: "09:30", end: "18:30" }]);
    expect(sched.weekly_rules.sat).toEqual([]);
    const [cc] = await sql`select access_token_enc, refresh_token_enc, status from app.calendar_connections where user_id = ${id}`;
    expect(cc.status).toBe("healthy");
    expect(cc.refresh_token_enc).not.toContain("refresh-1");
    expect(decryptSecret(cc.refresh_token_enc, id)).toBe("refresh-1");
  });

  it("allocates unique slugs and promotes seeded admins", async () => {
    const a = await completeLogin(claims("one@bigthinkcapital.com"), tokens());
    const b = await completeLogin(claims("mike.perticone@bigthinkcapital.com"), tokens());
    const rows = await sql`select id, slug, role from app.users order by created_at`;
    expect(rows.find((r) => r.id === a)?.slug).toBe("mike-perticone");
    expect(rows.find((r) => r.id === b)).toMatchObject({ slug: "mike-perticone-2", role: "admin" });
    const audit = await sql`select action from app.audit_log where entity_id = ${b}`;
    expect(audit.map((r) => r.action)).toContain("user.created");
  });

  it("rejects other domains and missing refresh tokens", async () => {
    await expect(completeLogin(claims("x@gmail.com"), tokens())).rejects.toBeInstanceOf(LoginRejected);
    await expect(completeLogin(claims("x@bigthinkcapital.com"), tokens({ refreshToken: null }))).rejects.toBeInstanceOf(LoginRejected);
  });

  it("activates pending queue memberships on sign-in", async () => {
    const [team] = await sql`insert into app.teams (name, slug, membership_source) values ('SDR', 'sdr', 'salesforce_queue') returning id`;
    await sql`insert into app.team_members (team_id, email, status, source) values (${team.id}, 'rep@bigthinkcapital.com', 'pending_onboarding', 'queue')`;
    const id = await completeLogin(claims("rep@bigthinkcapital.com"), tokens());
    const [m] = await sql`select user_id, status from app.team_members where team_id = ${team.id}`;
    expect(m).toMatchObject({ user_id: id, status: "active" });
    const [ev] = await sql`select old_status, new_status, source from app.membership_events`;
    expect(ev).toMatchObject({ old_status: "pending_onboarding", new_status: "active", source: "system" });
  });
});

describe("Graph token refresh", () => {
  async function userWithExpiredToken() {
    const u = await makeUser(sql, { calendar: null });
    await sql`
      insert into app.calendar_connections (user_id, status, access_token_enc, refresh_token_enc, token_expires_at)
      values (${u.id}, 'healthy', ${encryptSecret("old-access", u.id)}, ${encryptSecret("old-refresh", u.id)}, now() - interval '1 minute')`;
    return u;
  }

  it("returns the cached token while valid", async () => {
    const u = await makeUser(sql, { calendar: null });
    await sql`insert into app.calendar_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at)
      values (${u.id}, ${encryptSecret("cached", u.id)}, ${encryptSecret("r", u.id)}, now() + interval '30 minutes')`;
    let called = false;
    expect(await getGraphAccessToken(u.id, async () => ((called = true), tokens()))).toBe("cached");
    expect(called).toBe(false);
  });

  it("refreshes, rotates the refresh token, and serializes concurrent refreshes", async () => {
    const u = await userWithExpiredToken();
    let calls = 0;
    const refresher = async (rt: string) => {
      calls++;
      expect(rt).toBe("old-refresh");
      await new Promise((r) => setTimeout(r, 50));
      return tokens({ accessToken: "new-access", refreshToken: "new-refresh" });
    };
    const results = await Promise.all([getGraphAccessToken(u.id, refresher), getGraphAccessToken(u.id, refresher)]);
    expect(results).toEqual(["new-access", "new-access"]);
    expect(calls).toBe(1);
    const [cc] = await sql`select refresh_token_enc from app.calendar_connections where user_id = ${u.id}`;
    expect(decryptSecret(cc.refresh_token_enc, u.id)).toBe("new-refresh");
  });

  it("marks the connection broken on revoked consent", async () => {
    const u = await userWithExpiredToken();
    await expect(
      getGraphAccessToken(u.id, async () => {
        throw new TokenError("invalid_grant AADSTS70000", true, "invalid_grant");
      }),
    ).rejects.toBeInstanceOf(CalendarConnectionBroken);
    const [cc] = await sql`select status, broken_at, last_error from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.status).toBe("broken");
    expect(cc.broken_at).not.toBeNull();
  });

  it("does not mark the connection broken on a transient outage", async () => {
    const u = await userWithExpiredToken();
    await expect(
      getGraphAccessToken(u.id, async () => {
        throw new TokenError("temporarily_unavailable", false);
      }),
    ).rejects.toBeInstanceOf(TokenError);
    const [cc] = await sql`select status from app.calendar_connections where user_id = ${u.id}`;
    expect(cc.status).toBe("healthy");
  });
});

describe("job worker", () => {
  it("is idempotent on (kind, idempotency key)", async () => {
    const a = await enqueue(sql, { kind: "test", payload: {}, idempotencyKey: "k" });
    const b = await enqueue(sql, { kind: "test", payload: {}, idempotencyKey: "k" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("retries with backoff, then dead-letters at max attempts, logging each attempt", async () => {
    const id = await enqueue(sql, { kind: "flaky", payload: {}, maxAttempts: 2 });
    const handlers = {
      flaky: async (_j: unknown, ctx: { log: (e: object) => void }) => {
        ctx.log({ request: { url: "https://example.test" }, responseCode: 503 });
        throw new Error("upstream 503");
      },
    };
    await runJobs(handlers, { deadlineMs: 2000 });
    let [job] = await sql`select status, attempts, run_at > now() as later from app.jobs where id = ${id}`;
    expect(job).toMatchObject({ status: "failed", attempts: 1, later: true });
    await sql`update app.jobs set run_at = now() where id = ${id}`;
    await runJobs(handlers, { deadlineMs: 2000 });
    [job] = await sql`select status, attempts from app.jobs where id = ${id}`;
    expect(job).toMatchObject({ status: "dead", attempts: 2 });
    const attempts = await sql`select response_code, error from app.job_attempts where job_id = ${id} order by attempt_no`;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ response_code: 503, error: "upstream 503" });
  });

  it("stops immediately on a permanent error and stores the result", async () => {
    const id = await enqueue(sql, { kind: "bad", payload: {} });
    await runJobs({ bad: async () => { throw new PermanentJobError("rejected", { status: "duplicate" }); } }, { deadlineMs: 2000 });
    const [job] = await sql`select status, result from app.jobs where id = ${id}`;
    expect(job).toMatchObject({ status: "dead", result: { status: "duplicate" } });
  });

  it("never runs the same job twice under concurrent workers", async () => {
    for (let i = 0; i < 20; i++) await enqueue(sql, { kind: "count", payload: { i } });
    const seen: number[] = [];
    const handlers = { count: async (j: { payload: Record<string, unknown> }) => { seen.push(j.payload.i as number); await new Promise((r) => setTimeout(r, 5)); } };
    await Promise.all([runJobs(handlers, { limit: 3, deadlineMs: 5000 }), runJobs(handlers, { limit: 3, deadlineMs: 5000 }), runJobs(handlers, { limit: 3, deadlineMs: 5000 })]);
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(20).keys()]);
  });
});
