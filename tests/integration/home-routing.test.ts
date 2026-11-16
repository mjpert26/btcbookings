import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import { withUser, type Sql } from "@/server/db/client";
import type { SessionUser } from "@/server/auth/session";
import { resetEnvCache } from "@/server/env";
import { resetIntegrationSettingsCache, integrationSettings } from "@/server/settings/integrations";
import { setIntegrationSetting } from "@/server/settings/admin";
import { RENEWAL_BOOKS } from "@/lib/home-routing";
import type { LookupData, LookupOpportunity } from "@/server/home/decide";

// Server actions read the signed-in user, request headers and the cache; stand those in.
const current = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUser: async () => current.user,
  requireAdmin: async () => current.user,
}));

const { POST } = await import("@/app/api/public/lookup/route");
const { saveHomeRoutingAction, testHomeRoutingAction } = await import("@/app/(app)/admin/_actions/home-routing");
const { readHomeRouting, resolveDestination, personalDefaultPage } = await import("@/server/home/destination");
const { routeVisitor } = await import("@/server/home/route");
const { getHomeRoutingForEdit } = await import("@/server/home/admin");

/** Home page routing: destinations, the public lookup route, Admin > Home page and RLS. */

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb(10);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
  resetIntegrationSettingsCache();
  current.user = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
  resetIntegrationSettingsCache();
});

const IDLE = { status: "idle" } as never;
const ORIGIN = "http://localhost:3000";
const TOKEN = "lookup-token-0123456789-abcdefghijklmnop";

function signIn(u: { id: string; email: string }, role: SessionUser["role"]) {
  current.user = { id: u.id, email: u.email, name: "Signed In", slug: "signed-in", role, timezone: "America/New_York", languages: ["en"], photoUrl: null, calendarStatus: "healthy" };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function setRouting(over: Partial<{ newBusiness: string | null; renewalDefault: string | null; books: Record<string, string>; excluded: string[] }> = {}) {
  await sql`
    insert into app.home_routing (id, new_business_event_type_id, renewal_default_event_type_id, renewal_books, excluded_owner_emails)
    values (true, ${over.newBusiness ?? null}, ${over.renewalDefault ?? null}, ${sql.json((over.books ?? {}) as never)}, ${over.excluded ?? []}::citext[])
    on conflict (id) do update set
      new_business_event_type_id = excluded.new_business_event_type_id,
      renewal_default_event_type_id = excluded.renewal_default_event_type_id,
      renewal_books = excluded.renewal_books,
      excluded_owner_emails = excluded.excluded_owner_emails
  `;
}

/** A team round-robin page with Spanish variant, used as the new-business pool. */
async function newBusinessPool() {
  const a = await makeHost(sql);
  const team = await makeTeam(sql, [a.id], { slug: "sales-pool" });
  const et = await makeEvent(sql, { teamId: team.id }, { slug: "intro", mode: "round_robin" });
  await makeEvent(sql, { teamId: team.id }, { slug: "intro", language: "es", parentId: et.id, mode: "round_robin" });
  return { team, eventTypeId: et.id };
}

function opp(over: Partial<LookupOpportunity> = {}): LookupOpportunity {
  return { open: true, renewal: false, funded: false, lastModified: "2026-11-01T00:00:00Z", owner: null, renewalCloser: null, book: null, ...over };
}

const found = (data: LookupData) => async () => ({ ok: true as const, data });
const ownerData = (email: string): LookupData => ({ opportunities: [opp({ owner: { email, active: true, standard: true } })], leads: [] });

describe("destination resolution", () => {
  it("picks the default personal page in the order 15min, 30min, financing-intro-call, else the only page", async () => {
    const host = await makeHost(sql, { slug: "ana" });
    const config = await readHomeRouting(sql);
    await makeEvent(sql, { userId: host.id }, { slug: "zeta" });
    await makeEvent(sql, { userId: host.id }, { slug: "financing-intro-call" });
    expect(await personalDefaultPage(sql, host.id, "en")).toBe("/ana/financing-intro-call");
    await makeEvent(sql, { userId: host.id }, { slug: "30min" });
    expect(await personalDefaultPage(sql, host.id, "en")).toBe("/ana/30min");
    // Inactive and unlisted pages do not count.
    await makeEvent(sql, { userId: host.id }, { slug: "15min", isActive: false });
    expect(await personalDefaultPage(sql, host.id, "en")).toBe("/ana/30min");
    await sql`update app.event_types set is_active = true, is_listed = false where owner_user_id = ${host.id} and slug = '15min'`;
    expect(await personalDefaultPage(sql, host.id, "en")).toBe("/ana/30min");
    await sql`update app.event_types set is_listed = true where owner_user_id = ${host.id} and slug = '15min'`;
    expect(await personalDefaultPage(sql, host.id, "en")).toBe("/ana/15min");

    const decision = { kind: "owner" as const, email: host.email.toUpperCase(), source: "opportunity" as const };
    expect(await resolveDestination(sql, decision, config, "en")).toEqual({ kind: "owner", path: "/ana/15min", repEmail: host.email.toLowerCase() });

    // Only one active listed page: that page. Two pages that are not preferred: no default.
    const solo = await makeHost(sql, { slug: "solo" });
    await makeEvent(sql, { userId: solo.id }, { slug: "consult" });
    expect(await personalDefaultPage(sql, solo.id, "en")).toBe("/solo/consult");
    await makeEvent(sql, { userId: solo.id }, { slug: "other" });
    expect(await personalDefaultPage(sql, solo.id, "en")).toBeNull();
  });

  it("sends Spanish visitors to the Spanish variant when it exists", async () => {
    const host = await makeHost(sql, { slug: "ana" });
    const et = await makeEvent(sql, { userId: host.id }, { slug: "15min" });
    expect(await personalDefaultPage(sql, host.id, "es")).toBe("/ana/15min");
    await makeEvent(sql, { userId: host.id }, { slug: "15min", language: "es", parentId: et.id });
    expect(await personalDefaultPage(sql, host.id, "es")).toBe("/ana/15min/es");
    expect(await personalDefaultPage(sql, host.id, "en")).toBe("/ana/15min");
    await sql`update app.event_types set is_active = false where language = 'es'`;
    expect(await personalDefaultPage(sql, host.id, "es")).toBe("/ana/15min");
  });

  it("requires an active owner with a healthy calendar, else falls through to the new-business page", async () => {
    const pool = await newBusinessPool();
    await setRouting({ newBusiness: pool.eventTypeId });
    const config = await readHomeRouting(sql);
    const broken = await makeHost(sql, { slug: "broken", calendar: "broken" });
    await makeEvent(sql, { userId: broken.id }, { slug: "15min" });
    const owner = (email: string) => ({ kind: "owner" as const, email, source: "lead" as const });
    expect(await resolveDestination(sql, owner(broken.email), config, "en")).toEqual({ kind: "new_business", path: "/t/sales-pool/intro", repEmail: null });
    expect(await resolveDestination(sql, owner(broken.email), config, "es")).toEqual({ kind: "new_business", path: "/t/sales-pool/intro/es", repEmail: null });

    const gone = await makeHost(sql, { slug: "gone" });
    await makeEvent(sql, { userId: gone.id }, { slug: "15min" });
    await sql`update app.users set is_active = false where id = ${gone.id}`;
    expect((await resolveDestination(sql, owner(gone.email), config, "en")).kind).toBe("new_business");

    const noCalendar = await makeUser(sql, { calendar: null });
    expect((await resolveDestination(sql, owner(noCalendar.email), config, "en")).kind).toBe("new_business");
    expect((await resolveDestination(sql, owner("nobody@bigthinkcapital.com"), config, "en")).kind).toBe("new_business");
  });

  it("uses the renewal page of the book, else the default, else the new-business page", async () => {
    const pool = await newBusinessPool();
    const r1 = await makeHost(sql);
    const r2 = await makeHost(sql);
    const book1Team = await makeTeam(sql, [r1.id], { slug: "renewals-one" });
    const book1 = await makeEvent(sql, { teamId: book1Team.id }, { slug: "renewal" });
    const defTeam = await makeTeam(sql, [r2.id], { slug: "renewals" });
    const def = await makeEvent(sql, { teamId: defTeam.id }, { slug: "renewal" });
    await setRouting({ newBusiness: pool.eventTypeId, renewalDefault: def.id, books: { "Book 1": book1.id } });
    let config = await readHomeRouting(sql);
    const renewal = (book: string | null) => ({ kind: "renewal" as const, book, preferredEmails: [] });

    expect(await resolveDestination(sql, renewal("Book 1"), config, "en")).toEqual({ kind: "renewal", path: "/t/renewals-one/renewal", repEmail: null });
    expect(await resolveDestination(sql, renewal("Book 2"), config, "en")).toEqual({ kind: "renewal", path: "/t/renewals/renewal", repEmail: null });
    expect(await resolveDestination(sql, renewal(null), config, "en")).toMatchObject({ path: "/t/renewals/renewal" });

    // A paused book page uses the default; no active renewal page sends the visitor to new business.
    await sql`update app.event_types set is_active = false where id = ${book1.id}`;
    expect(await resolveDestination(sql, renewal("Book 1"), config, "en")).toMatchObject({ kind: "renewal", path: "/t/renewals/renewal" });
    await sql`update app.event_types set is_active = false where id = ${def.id}`;
    expect(await resolveDestination(sql, renewal("Book 1"), config, "en")).toEqual({ kind: "new_business", path: "/t/sales-pool/intro", repEmail: null });

    // Nothing bookable at all.
    await setRouting({});
    config = await readHomeRouting(sql);
    expect(await resolveDestination(sql, renewal("Book 1"), config, "en")).toEqual({ kind: "none", path: null, repEmail: null });
    expect(await resolveDestination(sql, { kind: "new" }, config, "en")).toEqual({ kind: "none", path: null, repEmail: null });
  });

  it("sends a renewal to the preferred person's own page only when they host the renewal page", async () => {
    const host = await makeHost(sql, { slug: "rena" });
    await makeEvent(sql, { userId: host.id }, { slug: "30min" });
    const outsider = await makeHost(sql, { slug: "otto" });
    await makeEvent(sql, { userId: outsider.id }, { slug: "15min" });
    const other = await makeHost(sql);
    const team = await makeTeam(sql, [host.id, other.id], { slug: "renewals" });
    const page = await makeEvent(sql, { teamId: team.id }, { slug: "renewal" });
    await setRouting({ renewalDefault: page.id });
    const config = await readHomeRouting(sql);
    const renewal = (preferredEmails: string[]) => ({ kind: "renewal" as const, book: "Book 3", preferredEmails });

    expect(await resolveDestination(sql, renewal([outsider.email, host.email]), config, "en")).toEqual({
      kind: "renewal_rep",
      path: "/rena/30min",
      repEmail: host.email.toLowerCase(),
    });
    expect(await resolveDestination(sql, renewal([outsider.email]), config, "en")).toEqual({ kind: "renewal", path: "/t/renewals/renewal", repEmail: null });

    // Paused member, a broken calendar, or event-type hosts that exclude the person: the renewal page.
    await sql`update app.team_members set status = 'paused' where user_id = ${host.id}`;
    expect((await resolveDestination(sql, renewal([host.email]), config, "en")).kind).toBe("renewal");
    await sql`update app.team_members set status = 'active' where user_id = ${host.id}`;
    await sql`update app.calendar_connections set status = 'broken' where user_id = ${host.id}`;
    expect((await resolveDestination(sql, renewal([host.email]), config, "en")).kind).toBe("renewal");
    await sql`update app.calendar_connections set status = 'healthy' where user_id = ${host.id}`;
    await sql`insert into app.event_type_hosts (event_type_id, team_member_id) values (${page.id}, ${team.memberIds[other.id]})`;
    expect((await resolveDestination(sql, renewal([host.email]), config, "en")).kind).toBe("renewal");
    await sql`delete from app.event_type_hosts`;
    // A host without a bookable page of their own stays on the renewal page.
    await sql`update app.event_types set is_active = false where owner_user_id = ${host.id}`;
    expect((await resolveDestination(sql, renewal([host.email]), config, "en")).kind).toBe("renewal");
  });

  it("routes through the decision with the configured exclusions", async () => {
    const pool = await newBusinessPool();
    const host = await makeHost(sql, { slug: "ana" });
    await makeEvent(sql, { userId: host.id }, { slug: "15min" });
    await setRouting({ newBusiness: pool.eventTypeId, excluded: [host.email.toUpperCase()] });
    const excluded = await routeVisitor("visitor@example.com", { locale: "en", lookup: found(ownerData(host.email)) });
    expect(excluded).toMatchObject({ next: "/t/sales-pool/intro", lookup: "ok", decision: { kind: "new" } });

    await setRouting({ newBusiness: pool.eventTypeId, excluded: [] });
    const routed = await routeVisitor("visitor@example.com", { locale: "en", lookup: found(ownerData(host.email)) });
    expect(routed).toMatchObject({ next: "/ana/15min", decision: { kind: "owner" }, destination: { kind: "owner" } });

    // Failures and the daily cap route as new.
    const failed = await routeVisitor("visitor@example.com", { locale: "en", lookup: async () => ({ ok: false, reason: "status_502" }) });
    expect(failed).toMatchObject({ next: "/t/sales-pool/intro", lookup: "status_502" });
    let called = false;
    const capped = await routeVisitor("visitor@example.com", {
      locale: "en",
      skipLookup: true,
      lookup: async () => {
        called = true;
        return { ok: false, reason: "x" };
      },
    });
    expect(capped).toMatchObject({ next: "/t/sales-pool/intro", lookup: "skipped" });
    expect(called).toBe(false);
  });

  it("applies the default exclusions when the configuration row is missing", async () => {
    await sql`delete from app.home_routing`;
    const config = await readHomeRouting(sql);
    expect(config.excludedOwnerEmails).toContain("sdr.roundrobin@bigthinkcapital.com");
    expect(config.newBusinessEventTypeId).toBeNull();
  });
});

describe("POST /api/public/lookup", () => {
  let ipSeq = 0;
  function request(body: unknown, init: { origin?: string | null; ip?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": init.ip ?? `198.51.100.${++ipSeq}` };
    if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
    return new NextRequest(`${ORIGIN}/api/public/lookup`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  }

  function stubN8n(answer: () => Response) {
    vi.stubEnv("N8N_LOOKUP_TOKEN", TOKEN);
    resetEnvCache();
    const calls: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
      return answer();
    });
    return calls;
  }

  it("rejects requests from other origins", async () => {
    for (const origin of [null, "https://evil.example", "not a url"]) {
      const res = await POST(request({ email: "a@example.com" }, { origin }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });

  it("validates the body", async () => {
    for (const body of ["not json", { email: "not-an-email" }, { email: `${"a".repeat(250)}@example.com` }, { email: "a@example.com", lang: "fr" }, {}]) {
      const res = await POST(request(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid" });
    }
  });

  it("answers only { next } and routes without a token (Turnstile skipped without a secret)", async () => {
    const pool = await newBusinessPool();
    await setRouting({ newBusiness: pool.eventTypeId });
    const res = await POST(request({ email: "Visitor@Example.com", turnstileToken: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ next: "/t/sales-pool/intro" });
    const es = await POST(request({ email: "visitor@example.com", lang: "es" }));
    expect(await es.json()).toEqual({ next: "/t/sales-pool/intro/es" });

    await setRouting({});
    const none = await POST(request({ email: "visitor2@example.com" }));
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ next: null });
  });

  it("calls n8n with the bearer token and sends the visitor to the account manager", async () => {
    const pool = await newBusinessPool();
    const host = await makeHost(sql, { slug: "ana" });
    await makeEvent(sql, { userId: host.id }, { slug: "15min" });
    await setRouting({ newBusiness: pool.eventTypeId });
    const calls = stubN8n(() => Response.json(ownerData(host.email)));

    const res = await POST(request({ email: " Merchant@Example.com " }));
    const body = await res.json();
    expect(body).toEqual({ next: "/ana/15min" });
    expect(Object.keys(body)).toEqual(["next"]);
    expect(calls).toEqual([{ url: "https://api.bigthinkcapital.com/webhook/btc-scheduler/lookup", auth: `Bearer ${TOKEN}`, body: JSON.stringify({ email: "merchant@example.com" }) }]);
  });

  it("routes as new when n8n fails, without logging the email", async () => {
    const pool = await newBusinessPool();
    await setRouting({ newBusiness: pool.eventTypeId });
    stubN8n(() => new Response("bad gateway", { status: 502 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await POST(request({ email: "merchant@example.com" }));
      expect(await res.json()).toEqual({ next: "/t/sales-pool/intro" });
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("status_502");
      expect(logged).not.toContain("merchant@example.com");
    } finally {
      warn.mockRestore();
    }
  });

  it("limits requests per IP and per email", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(request({ email: `v${i}@example.com` }, { ip: "192.0.2.1" }))).status).toBe(200);
    const limited = await POST(request({ email: "v9@example.com" }, { ip: "192.0.2.1" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) expect((await POST(request({ email: "same@example.com" }))).status).toBe(200);
    expect((await POST(request({ email: "SAME@example.com" }))).status).toBe(429);
  });

  it("skips the Salesforce lookup at the daily cap and still offers the new-business page", async () => {
    const pool = await newBusinessPool();
    const host = await makeHost(sql, { slug: "ana" });
    await makeEvent(sql, { userId: host.id }, { slug: "15min" });
    await setRouting({ newBusiness: pool.eventTypeId });
    const calls = stubN8n(() => Response.json(ownerData(host.email)));
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = new Date((nowSec - (nowSec % 86_400)) * 1000);
    await sql`insert into app.rate_limits (key, window_start, count) values ('lookup:global', ${windowStart}, 1000)`;
    const res = await POST(request({ email: "merchant@example.com" }));
    expect(await res.json()).toEqual({ next: "/t/sales-pool/intro" });
    expect(calls).toHaveLength(0);
  });

  it("requires a valid Turnstile token once a secret is set", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    resetEnvCache();
    const res = await POST(request({ email: "merchant@example.com" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "verification_failed" });
    vi.stubGlobal("fetch", async () => Response.json({ success: true, action: "book", hostname: "localhost" }));
    const wrongAction = await POST(request({ email: "merchant2@example.com", turnstileToken: "tok" }));
    expect(await wrongAction.json()).toEqual({ error: "verification_failed" });
    vi.stubGlobal("fetch", async () => Response.json({ success: true, action: "lookup", hostname: "localhost" }));
    const passed = await POST(request({ email: "merchant3@example.com", turnstileToken: "tok" }));
    expect(passed.status).toBe(200);
    expect(await passed.json()).toEqual({ next: null });
  });
});

describe("Admin > Home page actions", () => {
  async function fixture() {
    const admin = await makeUser(sql, { role: "admin" });
    const agent = await makeUser(sql);
    const pool = await newBusinessPool();
    const personal = await makeEvent(sql, { userId: agent.id }, { slug: "15min" });
    return { admin, agent, pool, personal };
  }

  const baseForm = (over: Record<string, string> = {}) =>
    form({
      newBusinessEventTypeId: "",
      renewalDefaultEventTypeId: "",
      ...Object.fromEntries(RENEWAL_BOOKS.map((b) => [`book:${b}`, ""])),
      excludedOwnerEmails: "",
      ...over,
    });

  async function audits(action: string) {
    return sql<{ actor_user_id: string; entity_type: string; before: unknown; after: Record<string, unknown> | null; ip_hash: string | null }[]>`
      select actor_user_id, entity_type, before, after, ip_hash from app.audit_log where action = ${action} order by created_at
    `;
  }

  it("saves for admins and writes the audit entry in the same transaction", async () => {
    const { admin, pool, personal } = await fixture();
    signIn(admin, "admin");
    const res = await saveHomeRoutingAction(
      IDLE,
      baseForm({
        newBusinessEventTypeId: pool.eventTypeId,
        renewalDefaultEventTypeId: personal.id,
        "book:Book 2": pool.eventTypeId,
        excludedOwnerEmails: "TeamDC@bigthinkcapital.com\n\n teamdc@bigthinkcapital.com, shaine@forml.ai ",
      }),
    );
    expect(res).toMatchObject({ status: "success" });
    const [row] = await sql<{ new_business_event_type_id: string; renewal_default_event_type_id: string; renewal_books: unknown; excluded_owner_emails: string[]; updated_by: string }[]>`
      select new_business_event_type_id, renewal_default_event_type_id, renewal_books, excluded_owner_emails::text[] as excluded_owner_emails, updated_by from app.home_routing
    `;
    expect(row).toEqual({
      new_business_event_type_id: pool.eventTypeId,
      renewal_default_event_type_id: personal.id,
      renewal_books: { "Book 2": pool.eventTypeId },
      excluded_owner_emails: ["teamdc@bigthinkcapital.com", "shaine@forml.ai"],
      updated_by: admin.id,
    });
    const [entry] = await audits("home_routing.update");
    expect(entry).toMatchObject({ actor_user_id: admin.id, entity_type: "home_routing", before: null });
    expect(entry.after).toMatchObject({ newBusinessEventTypeId: pool.eventTypeId, excludedOwnerEmails: ["teamdc@bigthinkcapital.com", "shaine@forml.ai"] });
    expect(entry.ip_hash).toMatch(/^[0-9a-f]{32}$/);

    // The edit view reads it back under RLS.
    const edit = await getHomeRoutingForEdit(current.user!);
    expect(edit.state.renewalBooks).toEqual({ "Book 2": pool.eventTypeId });
    expect(edit.newBusinessOptions.map((o) => o.id)).toEqual([pool.eventTypeId]);
    expect(edit.newBusinessOptions[0]).toMatchObject({ isTeam: true, isActive: true, languages: ["en", "es"] });
    expect(edit.renewalOptions.map((o) => o.id).sort()).toEqual([pool.eventTypeId, personal.id].sort());

    // A second save records the previous values as `before`.
    expect(await saveHomeRoutingAction(IDLE, baseForm())).toMatchObject({ status: "success" });
    const entries = await audits("home_routing.update");
    expect(entries).toHaveLength(2);
    expect(entries[1].before).toMatchObject({ newBusinessEventTypeId: pool.eventTypeId });
    expect(entries[1].after).toMatchObject({ newBusinessEventTypeId: null, renewalBooks: {}, excludedOwnerEmails: [] });
  });

  it("refuses non-admins and writes nothing", async () => {
    const { agent, pool } = await fixture();
    signIn(agent, "user");
    expect(await saveHomeRoutingAction(IDLE, baseForm({ newBusinessEventTypeId: pool.eventTypeId }))).toMatchObject({
      status: "error",
      message: "You do not have permission to do that.",
    });
    expect(await testHomeRoutingAction(IDLE, form({ email: "merchant@example.com" }))).toMatchObject({ status: "error", message: "You do not have permission to do that." });
    expect(await sql`select 1 from app.home_routing`).toHaveLength(0);
    expect(await sql`select 1 from app.audit_log`).toHaveLength(0);
    await expect(getHomeRoutingForEdit(current.user!)).rejects.toThrow("Admin access required.");
  });

  it("validates the pages and the excluded emails", async () => {
    const { admin, personal } = await fixture();
    signIn(admin, "admin");
    const personalAsPool = await saveHomeRoutingAction(IDLE, baseForm({ newBusinessEventTypeId: personal.id }));
    expect(personalAsPool).toMatchObject({ status: "error", fieldErrors: { newBusinessEventTypeId: "Choose a team round-robin or collective booking page." } });
    const notUuid = await saveHomeRoutingAction(IDLE, baseForm({ "book:House Book": "abc" }));
    expect(notUuid).toMatchObject({ status: "error", fieldErrors: { "book:House Book": "Choose a booking page from the list." } });
    const missing = await saveHomeRoutingAction(IDLE, baseForm({ renewalDefaultEventTypeId: "00000000-0000-4000-8000-000000000099" }));
    expect(missing).toMatchObject({ status: "error", fieldErrors: { renewalDefaultEventTypeId: expect.stringContaining("no longer exists") } });
    const variant = await makeEvent(sql, { userId: admin.id }, { slug: "15min", language: "es", parentId: personal.id });
    expect(await saveHomeRoutingAction(IDLE, baseForm({ renewalDefaultEventTypeId: variant.id }))).toMatchObject({ status: "error" });
    const badEmail = await saveHomeRoutingAction(IDLE, baseForm({ excludedOwnerEmails: "ok@bigthinkcapital.com\nnot-an-email" }));
    expect(badEmail).toMatchObject({ status: "error", fieldErrors: { excludedOwnerEmails: "Not a valid email address: not-an-email." } });
    const tooMany = await saveHomeRoutingAction(IDLE, baseForm({ excludedOwnerEmails: Array.from({ length: 101 }, (_, i) => `u${i}@bigthinkcapital.com`).join("\n") }));
    expect(tooMany).toMatchObject({ status: "error", fieldErrors: { excludedOwnerEmails: "Enter at most 100 email addresses." } });
    expect(await sql`select 1 from app.home_routing`).toHaveLength(0);
    expect(await audits("home_routing.update")).toHaveLength(0);
  });

  it("tests an email for admins, changing nothing but one audit entry without the email", async () => {
    const { admin, pool } = await fixture();
    const host = await makeHost(sql, { slug: "ana" });
    await makeEvent(sql, { userId: host.id }, { slug: "15min" });
    await setRouting({ newBusiness: pool.eventTypeId });
    vi.stubEnv("N8N_LOOKUP_TOKEN", TOKEN);
    resetEnvCache();
    vi.stubGlobal("fetch", async () => Response.json(ownerData(host.email)));
    signIn(admin, "admin");

    const res = await testHomeRoutingAction(IDLE, form({ email: "Merchant@Example.com" }));
    expect(res).toMatchObject({
      status: "success",
      result: { decision: "owner", destination: "owner", repEmail: host.email.toLowerCase(), matchedEmail: host.email.toLowerCase(), path: "/ana/15min", lookup: "ok", book: null },
    });
    const all = await sql<{ action: string; after: unknown }[]>`select action, after from app.audit_log`;
    expect(all).toEqual([{ action: "home_routing.test", after: { decision: "owner", destination: "owner", lookup: "ok" } }]);
    expect(JSON.stringify(all)).not.toContain("merchant@example.com");
    expect(await sql`select 1 from app.rate_limits`).toHaveLength(0);

    expect(await testHomeRoutingAction(IDLE, form({ email: "nope" }))).toMatchObject({ status: "error", fieldErrors: { email: "Enter a valid email address." } });
  });
});

describe("app.home_routing: migration and row-level security", () => {
  it("is seeded with the default exclusions by the migration", async () => {
    // truncateAll empties the table; the column default is the seed list.
    await sql`insert into app.home_routing (id) values (true)`;
    const [row] = await sql<{ excluded_owner_emails: string[] }[]>`select excluded_owner_emails::text[] as excluded_owner_emails from app.home_routing`;
    expect(row.excluded_owner_emails).toEqual([
      "jessica.marks@bigthinkcapital.com",
      "jessica.marks2@bigthinkcapital.com",
      "jessica.marks3@bigthinkcapital.com",
      "jessica.marks4@bigthinkcapital.com",
      "teamaxkap@bigthinkcapital.com",
      "teamdc@bigthinkcapital.com",
      "sdr.roundrobin@bigthinkcapital.com",
      "shaine@forml.ai",
    ]);
    await expect(sql`insert into app.home_routing (id) values (false)`).rejects.toMatchObject({ code: "23514" });
  });

  it("lets only admins read and change the row", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const agent = await makeUser(sql);
    const manager = await makeUser(sql, { role: "manager" });
    await setRouting({ excluded: ["x@bigthinkcapital.com"] });

    for (const u of [agent, manager]) {
      expect(await withUser(u.id, (tx) => tx`select * from app.home_routing`)).toHaveLength(0);
      const updated = await withUser(u.id, (tx) => tx`update app.home_routing set excluded_owner_emails = '{}', updated_by = ${u.id} returning id`);
      expect(updated).toHaveLength(0);
      await expect(withUser(u.id, (tx) => tx`insert into app.home_routing (id, updated_by) values (true, ${u.id})`)).rejects.toMatchObject({ code: "42501" });
      await expect(withUser(u.id, (tx) => tx`delete from app.home_routing`)).rejects.toMatchObject({ code: "42501" });
    }
    const [row] = await sql<{ excluded_owner_emails: string[] }[]>`select excluded_owner_emails::text[] as excluded_owner_emails from app.home_routing`;
    expect(row.excluded_owner_emails).toEqual(["x@bigthinkcapital.com"]);

    expect(await withUser(admin.id, (tx) => tx`select id from app.home_routing`)).toHaveLength(1);
    // Admins must record themselves as the editor.
    await expect(withUser(admin.id, (tx) => tx`update app.home_routing set excluded_owner_emails = '{}', updated_by = ${agent.id}`)).rejects.toMatchObject({ code: "42501" });
    const ok = await withUser(admin.id, (tx) => tx`update app.home_routing set excluded_owner_emails = '{}', updated_by = ${admin.id} returning id`);
    expect(ok).toHaveLength(1);
  });

  it("accepts N8N_LOOKUP_TOKEN as an encrypted Admin > Settings secret", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const user: SessionUser = { id: admin.id, email: admin.email, name: "A", slug: "a", role: "admin", timezone: "America/New_York", languages: ["en"], photoUrl: null, calendarStatus: "healthy" };
    await setIntegrationSetting(user, "N8N_LOOKUP_TOKEN", TOKEN);
    const [row] = await sql<{ is_secret: boolean; value_plain: string | null; last4: string }[]>`
      select is_secret, value_plain, last4 from app.integration_settings where key = 'N8N_LOOKUP_TOKEN'
    `;
    expect(row).toEqual({ is_secret: true, value_plain: null, last4: "mnop" });
    expect((await integrationSettings({ fresh: true })).N8N_LOOKUP_TOKEN).toBe(TOKEN);
    await expect(sql`insert into app.integration_settings (key, is_secret, value_plain) values ('N8N_LOOKUP_TOKEN', false, 'x')`).rejects.toMatchObject({ code: "23514" });
  });
});
