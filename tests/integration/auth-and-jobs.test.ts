import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { withUser, type Sql } from "@/server/db/client";
import { completeLogin, LoginPendingLink, LoginRejected } from "@/server/auth/login";
import { decideLinkRequest, listPendingLinkRequests } from "@/server/auth/link-requests";
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
const named = (email: string, name: string) => ({ ...claims(email), name });

/** A dormant account created by the Calendly import. */
async function importedUser(email: string, name: string) {
  const u = await makeUser(sql, { email, name, calendar: null });
  await sql`update app.users set import_source = 'calendly', import_ref = ${"https://api.calendly.com/users/" + email} where id = ${u.id}`;
  return u;
}

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

  it("links a pre-provisioned account by user principal name when the mail address differs", async () => {
    const pre = await makeUser(sql, { email: "jdoe@bigthinkcapital.com", calendar: null });
    const id = await completeLogin({ ...claims("john.doe@bigthinkcapital.com"), preferredUsername: "JDoe@bigthinkcapital.com" }, tokens());
    expect(id).toBe(pre.id);
    const [u] = await sql`select email, entra_oid from app.users where id = ${id}`;
    expect(u).toMatchObject({ email: "john.doe@bigthinkcapital.com", entra_oid: "oid-john.doe@bigthinkcapital.com" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.users`;
    expect(n).toBe(1);
    const [audit] = await sql`select before, after from app.audit_log where action = 'user.linked' and entity_id = ${id}`;
    expect(audit.before).toEqual({ email: "jdoe@bigthinkcapital.com" });
  });

  it("never links an imported account by display name alone: the sign-in is held for an admin", async () => {
    // chris.lee@ is a real mailbox whose owner has not signed in yet. A different employee
    // with the same display name signs in first.
    const imported = await importedUser("chris.lee@bigthinkcapital.com", "Chris Lee");
    await expect(completeLogin(named("clee@bigthinkcapital.com", "Chris Lee"), tokens())).rejects.toBeInstanceOf(LoginPendingLink);
    await expect(completeLogin(named("clee@bigthinkcapital.com", "Chris Lee"), tokens())).rejects.toBeInstanceOf(LoginPendingLink);

    // The imported account is untouched, no account or tokens were created, and one request
    // records both attempts.
    const [row] = await sql`select email::text as email, entra_oid, last_login_at from app.users where id = ${imported.id}`;
    expect(row).toEqual({ email: "chris.lee@bigthinkcapital.com", entra_oid: null, last_login_at: null });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.users`;
    expect(n).toBe(1);
    expect(await sql`select 1 from app.calendar_connections`).toHaveLength(0);
    expect(await sql`select 1 from app.jobs`).toHaveLength(0);
    const requests = await sql`select user_id, entra_oid, email::text as email, status, attempts from app.account_link_requests`;
    expect(requests).toEqual([{ user_id: imported.id, entra_oid: "oid-clee@bigthinkcapital.com", email: "clee@bigthinkcapital.com", status: "pending", attempts: 2 }]);
    const audit = await sql`select action from app.audit_log where entity_id = ${imported.id}`;
    expect(audit.map((a) => a.action)).toEqual(["user.link_requested"]);

    // The real owner signs in by email and gets the imported account.
    const owner = await completeLogin(named("chris.lee@bigthinkcapital.com", "Chris Lee"), tokens());
    expect(owner).toBe(imported.id);
  });

  it("links a held sign-in only after an admin confirms it, and gives a new account after a rejection", async () => {
    const admin = await makeUser(sql, { role: "admin", name: "Admin" });
    const henao = await importedUser("chris.henao@bigthinkcapital.com", "Christopher Henao");
    await sql`update app.users set role = 'manager' where id = ${henao.id}`;
    await expect(completeLogin(named("christopher.henao@bigthinkcapital.com", "Christopher Henao"), tokens())).rejects.toBeInstanceOf(LoginPendingLink);
    // A second, different person with the same name is held as well.
    await expect(completeLogin(named("chenao@bigthinkcapital.com", "Christopher Henao"), tokens())).rejects.toBeInstanceOf(LoginPendingLink);

    const pending = await withUser(admin.id, (tx) => listPendingLinkRequests(tx));
    expect(pending.map((p) => p.email).sort()).toEqual(["chenao@bigthinkcapital.com", "christopher.henao@bigthinkcapital.com"]);
    expect(pending[0]).toMatchObject({ imported_email: "chris.henao@bigthinkcapital.com", imported_role: "manager" });
    // Only admins see or decide requests.
    const agent = await makeUser(sql, { name: "Agent" });
    expect(await withUser(agent.id, (tx) => listPendingLinkRequests(tx))).toHaveLength(0);
    const right = pending.find((p) => p.email === "christopher.henao@bigthinkcapital.com")!;
    await expect(withUser(agent.id, (tx) => tx`select app.link_imported_account(${henao.id}, 'oid-x', 'x@bigthinkcapital.com')`)).rejects.toMatchObject({ code: "42501" });

    const res = await withUser(admin.id, (tx) => decideLinkRequest(tx, admin.id, { requestId: right.id, decision: "approve" }));
    expect(res.ok).toBe(true);
    const statuses = await sql`select email::text as email, status, decided_by from app.account_link_requests order by email`;
    expect(statuses).toEqual([
      { email: "chenao@bigthinkcapital.com", status: "rejected", decided_by: admin.id },
      { email: "christopher.henao@bigthinkcapital.com", status: "approved", decided_by: admin.id },
    ]);
    const [audit] = await sql`select actor_user_id, before, after from app.audit_log where action = 'user.link_approved'`;
    expect(audit).toMatchObject({ actor_user_id: admin.id, before: { email: "chris.henao@bigthinkcapital.com" }, after: { email: "christopher.henao@bigthinkcapital.com" } });
    expect(await withUser(admin.id, (tx) => listPendingLinkRequests(tx))).toHaveLength(0);
    // Deciding again is refused.
    expect((await withUser(admin.id, (tx) => decideLinkRequest(tx, admin.id, { requestId: right.id, decision: "reject" }))).ok).toBe(false);

    // The confirmed person now signs in to the imported account, with its role kept.
    const id = await completeLogin(named("christopher.henao@bigthinkcapital.com", "Christopher Henao"), tokens());
    expect(id).toBe(henao.id);
    const [linked] = await sql`select role, last_login_at from app.users where id = ${henao.id}`;
    expect(linked.role).toBe("manager");
    expect(linked.last_login_at).not.toBeNull();
    // The other person was rejected with it, so they get a new account.
    const other = await completeLogin(named("chenao@bigthinkcapital.com", "Christopher Henao"), tokens());
    expect(other).not.toBe(henao.id);

    // An explicit rejection: the next sign-in creates a new, empty account.
    const pat = await importedUser("pat.lee@bigthinkcapital.com", "Pat Lee");
    await expect(completeLogin(named("plee@bigthinkcapital.com", "Pat Lee"), tokens())).rejects.toBeInstanceOf(LoginPendingLink);
    const [req] = await sql`select id from app.account_link_requests where user_id = ${pat.id}`;
    expect((await withUser(admin.id, (tx) => decideLinkRequest(tx, admin.id, { requestId: req.id, decision: "reject" }))).ok).toBe(true);
    const fresh = await completeLogin(named("plee@bigthinkcapital.com", "Pat Lee"), tokens());
    expect(fresh).not.toBe(pat.id);
    const [p] = await sql`select entra_oid, email::text as email from app.users where id = ${pat.id}`;
    expect(p).toEqual({ entra_oid: null, email: "pat.lee@bigthinkcapital.com" });
  });

  it("creates a new account when the name matches several, a deactivated or an already linked imported account", async () => {
    for (const e of ["sam.smith1@bigthinkcapital.com", "sam.smith2@bigthinkcapital.com"]) await importedUser(e, "Sam Smith");
    const sam = await completeLogin(named("samuel.smith@bigthinkcapital.com", "Sam Smith"), tokens());
    const [s] = await sql`select import_source from app.users where id = ${sam}`;
    expect(s.import_source).toBeNull();

    // A departed person's deactivated import must not block a new employee with the same name.
    const departed = await importedUser("pat.doe@bigthinkcapital.com", "Pat Doe");
    await sql`update app.users set is_active = false where id = ${departed.id}`;
    const pat = await completeLogin(named("patricia.doe2@bigthinkcapital.com", "Pat Doe"), tokens());
    expect(pat).not.toBe(departed.id);

    const linked = await importedUser("jo.park@bigthinkcapital.com", "Jo Park");
    await sql`update app.users set entra_oid = 'oid-jo', last_login_at = now() where id = ${linked.id}`;
    const jo = await completeLogin(named("jpark@bigthinkcapital.com", "Jo Park"), tokens());
    expect(jo).not.toBe(linked.id);
    expect(await sql`select 1 from app.account_link_requests`).toHaveLength(0);
  });

  it("never gives two Microsoft accounts signing in at the same moment the same user", async () => {
    // Account A's user principal name and account B's mail address both match the row.
    for (let i = 0; i < 3; i++) {
      await truncateAll(sql);
      const row = await makeUser(sql, { email: "jdoe@bigthinkcapital.com", calendar: null });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      // Holding a lock on app.users lines both sign-ins up on their first read.
      const holder = sql.begin(async (tx) => {
        await tx`lock table app.users in access exclusive mode`;
        locked();
        await gate;
      });
      await isLocked;
      const a = completeLogin({ ...claims("john.doe@bigthinkcapital.com", "oid-a"), preferredUsername: "jdoe@bigthinkcapital.com" }, tokens());
      const b = completeLogin(claims("jdoe@bigthinkcapital.com", "oid-b"), tokens());
      await new Promise((r) => setTimeout(r, 200));
      release();
      await holder;
      const [ra, rb] = await Promise.allSettled([a, b]);
      const ids = [ra, rb].filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
      expect(new Set(ids).size).toBe(ids.length);
      const [owner] = await sql<{ entra_oid: string }[]>`select entra_oid from app.users where id = ${row.id}`;
      const winner = owner.entra_oid === "oid-a" ? ra : rb;
      expect(winner).toMatchObject({ status: "fulfilled", value: row.id });
    }
  });

  it("prefers the mail match and never links by user principal name to an account linked elsewhere", async () => {
    // Another person's linked account happens to use this user's UPN as its email.
    const other = await makeUser(sql, { email: "jdoe@bigthinkcapital.com" });
    await sql`update app.users set entra_oid = 'oid-other' where id = ${other.id}`;
    const own = await makeUser(sql, { email: "john.doe@bigthinkcapital.com", calendar: null });
    const id = await completeLogin({ ...claims("john.doe@bigthinkcapital.com"), preferredUsername: "jdoe@bigthinkcapital.com" }, tokens());
    expect(id).toBe(own.id);
    const [o] = await sql`select entra_oid from app.users where id = ${other.id}`;
    expect(o.entra_oid).toBe("oid-other");
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
