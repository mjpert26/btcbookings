import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { makeBooking, makeIndividualEventType, makeTeamEventType } from "../helpers/booking-fixtures";
import { pngBytes, svgBytes, webpBytes } from "../helpers/images";
import { withUser, type Sql } from "@/server/db/client";
import { withAuditContext } from "@/server/audit";
import { sha256Hex } from "@/server/crypto/random";
import {
  getPartnerBranding,
  getPartnerBrandingForEventType,
  getPartnerBrandingForManageToken,
  getTeamBrandingForEdit,
  removeTeamLogo,
  savePageSettings,
  TeamBrandingError,
  uploadTeamLogo,
} from "@/server/teams/branding";
import { LogoValidationError } from "@/server/teams/logo";
import { getBookingByToken } from "@/server/booking/manage";
import { visibleHosts } from "@/components/public/branding";
import { GET as logoGET } from "@/app/api/public/team-logo/[teamId]/route";
import { brand } from "@/theme/brand";
import { partnerNameForEventType } from "@/server/email/partner";

/** Partner page settings and logos: permissions, RLS, audit, the public logo route and rendering data. */

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

type Fixture = {
  teamA: string;
  teamB: string;
  admin: { id: string };
  teamAdminA: { id: string };
  teamAdminB: { id: string };
  agent: { id: string };
  manager: { id: string };
};

async function setup(): Promise<Fixture> {
  const { teamId: teamA } = await makeTeamEventType(sql);
  const { teamId: teamB } = await makeTeamEventType(sql);
  const admin = await makeUser(sql, { role: "admin" });
  const teamAdminA = await makeUser(sql);
  const teamAdminB = await makeUser(sql);
  const agent = await makeUser(sql);
  const manager = await makeUser(sql);
  await sql`update app.users set role = 'manager' where id = ${manager.id}`;
  await sql`insert into app.team_admins (team_id, user_id) values (${teamA}, ${teamAdminA.id}), (${teamB}, ${teamAdminB.id})`;
  return { teamA, teamB, admin, teamAdminA, teamAdminB, agent, manager };
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (e) {
    if (e instanceof TeamBrandingError) return e.code;
    if (e instanceof LogoValidationError) return `logo:${e.code}`;
    if (e instanceof ZodError) return "zod";
    if (e && typeof e === "object" && "code" in e) return `pg:${String((e as { code: unknown }).code)}`;
    throw e;
  }
}

function logoRequest(teamId: string, init: { v?: string; ifNoneMatch?: string } = {}) {
  const url = new URL(`http://localhost:3000/api/public/team-logo/${teamId}`);
  if (init.v) url.searchParams.set("v", init.v);
  const req = new Request(url, { headers: init.ifNoneMatch ? { "if-none-match": init.ifNoneMatch } : {} });
  return logoGET(req, { params: Promise.resolve({ teamId }) });
}

describe("page settings", () => {
  it("lets a team admin save settings and audits only the changed fields", async () => {
    const f = await setup();
    const res = await withAuditContext({ ipHash: "iphash-1" }, () =>
      savePageSettings(f.teamAdminA, f.teamA, { displayName: "Acme Funding", showHostPhoto: false, showBtcLogo: true }),
    );
    expect(res.changed).toBe(true);
    const [team] = await sql<{ page_settings: Record<string, unknown> }[]>`select page_settings from app.teams where id = ${f.teamA}`;
    expect(team.page_settings).toMatchObject({ displayName: "Acme Funding", showHostPhoto: false, showBtcLogo: true });
    // Fields left out of the input take their defaults.
    expect(team.page_settings.showDuration).toBe(true);

    const audits = await sql<{ actor_user_id: string; action: string; entity_id: string; before: Record<string, unknown>; after: Record<string, unknown>; ip_hash: string }[]>`
      select actor_user_id, action, entity_id, before, after, ip_hash from app.audit_log where action = 'team.page_settings_update'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: f.teamAdminA.id, entity_id: f.teamA, ip_hash: "iphash-1" });
    expect(audits[0].after).toEqual({ displayName: "Acme Funding", showHostPhoto: false });
    expect(audits[0].before).toEqual({ displayName: null, showHostPhoto: true });
    expect(audits[0].after).not.toHaveProperty("showBtcLogo");
  });

  it("writes nothing when nothing changed", async () => {
    const f = await setup();
    const input = { heading: "Welcome", showHostPhoto: true, showHostName: true, showBtcLogo: true, showDuration: true, showDescription: true, showPartnerLogo: true };
    expect((await savePageSettings(f.admin, f.teamA, input)).changed).toBe(true);
    expect((await savePageSettings(f.admin, f.teamA, input)).changed).toBe(false);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.audit_log where action = 'team.page_settings_update'`;
    expect(n).toBe(1);
  });

  it("rejects unknown keys and invalid values before touching the database", async () => {
    const f = await setup();
    expect(await errorCode(savePageSettings(f.teamAdminA, f.teamA, { customCss: "body{}" }))).toBe("zod");
    expect(await errorCode(savePageSettings(f.teamAdminA, f.teamA, { accentColor: "blue" }))).toBe("zod");
    expect(await errorCode(savePageSettings(f.teamAdminA, f.teamA, { displayName: "x".repeat(81) }))).toBe("zod");
  });

  it("allows only admins and that team's admins", async () => {
    const f = await setup();
    expect(await errorCode(savePageSettings(f.agent, f.teamA, { heading: "Hi" }))).toBe("forbidden");
    expect(await errorCode(savePageSettings(f.manager, f.teamA, { heading: "Hi" }))).toBe("forbidden");
    expect(await errorCode(savePageSettings(f.teamAdminB, f.teamA, { heading: "Hi" }))).toBe("forbidden");
    expect(await errorCode(savePageSettings(f.teamAdminA, f.teamB, { heading: "Hi" }))).toBe("forbidden");
    expect(await errorCode(savePageSettings(f.admin, f.teamB, { heading: "Hi" }))).toBe("none");
    expect(await errorCode(savePageSettings(f.admin, "00000000-0000-4000-8000-00000000abcd", {}))).toBe("not_found");
    expect(await errorCode(getTeamBrandingForEdit(f.agent, f.teamA))).toBe("forbidden");
    const edit = await getTeamBrandingForEdit(f.teamAdminA, f.teamA);
    expect(edit.settings.showBtcLogo).toBe(true);
  });

  it("enforces team scoping in the database for direct writes", async () => {
    const f = await setup();
    const own = await withUser(f.teamAdminA.id, (tx) => tx`update app.teams set page_settings = '{"heading":"Own"}'::jsonb where id = ${f.teamA}`);
    expect(own.count).toBe(1);
    const other = await withUser(f.teamAdminA.id, (tx) => tx`update app.teams set page_settings = '{"heading":"Other"}'::jsonb where id = ${f.teamB}`);
    expect(other.count).toBe(0);
    const agent = await withUser(f.agent.id, (tx) => tx`update app.teams set page_settings = '{}'::jsonb where id = ${f.teamA}`);
    expect(agent.count).toBe(0);
    // Sync and safety-rail columns stay admin-only for team admins.
    expect(await errorCode(withUser(f.teamAdminA.id, (tx) => tx`update app.teams set membership_source = 'salesforce_queue' where id = ${f.teamA}`))).toBe("pg:42501");
    // The column must hold a JSON object.
    expect(await errorCode(sql`update app.teams set page_settings = '[]'::jsonb where id = ${f.teamA}`)).toBe("pg:23514");
  });
});

describe("logos", () => {
  it("uploads a logo, audits it and serves it with strict headers", async () => {
    const f = await setup();
    const png = pngBytes(300, 100);
    const up = await uploadTeamLogo(f.teamAdminA, f.teamA, png, "image/png");
    expect(up).toMatchObject({ contentType: "image/png", width: 300, height: 100 });

    const [audit] = await sql<{ action: string; after: Record<string, unknown> }[]>`select action, after from app.audit_log where action like 'team.logo%'`;
    expect(audit.action).toBe("team.logo_upload");
    expect(audit.after).toMatchObject({ content_type: "image/png", sha256: up.sha256, byte_size: png.byteLength });

    const res = await logoRequest(f.teamA);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("etag")).toBe(`"${up.sha256}"`);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);

    const pinned = await logoRequest(f.teamA, { v: up.sha256.slice(0, 16) });
    expect(pinned.headers.get("cache-control")).toContain("immutable");
    const stale = await logoRequest(f.teamA, { v: "0000000000000000" });
    expect(stale.headers.get("cache-control")).not.toContain("immutable");

    const notModified = await logoRequest(f.teamA, { ifNoneMatch: `"${up.sha256}"` });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    expect((await logoRequest(f.teamB)).status).toBe(404);
    expect((await logoRequest("not-a-uuid")).status).toBe(404);
  });

  it("replaces and removes logos with audit entries", async () => {
    const f = await setup();
    await uploadTeamLogo(f.admin, f.teamA, pngBytes(), "image/png");
    const second = await uploadTeamLogo(f.teamAdminA, f.teamA, webpBytes(400, 100), "image/webp");
    const res = await logoRequest(f.teamA);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("etag")).toBe(`"${second.sha256}"`);
    expect((await removeTeamLogo(f.teamAdminA, f.teamA)).removed).toBe(true);
    expect((await removeTeamLogo(f.teamAdminA, f.teamA)).removed).toBe(false);
    expect((await logoRequest(f.teamA)).status).toBe(404);
    const actions = await sql<{ action: string }[]>`select action from app.audit_log where action like 'team.logo%' order by created_at, id`;
    expect(actions.map((a) => a.action).sort()).toEqual(["team.logo_remove", "team.logo_replace", "team.logo_upload"]);
  });

  it("rejects SVG and mismatched files and other teams' admins", async () => {
    const f = await setup();
    expect(await errorCode(uploadTeamLogo(f.teamAdminA, f.teamA, svgBytes(), "image/svg+xml"))).toBe("logo:unsupported_type");
    expect(await errorCode(uploadTeamLogo(f.teamAdminA, f.teamA, pngBytes(), "image/jpeg"))).toBe("logo:type_mismatch");
    expect(await errorCode(uploadTeamLogo(f.teamAdminB, f.teamA, pngBytes(), "image/png"))).toBe("forbidden");
    expect(await errorCode(uploadTeamLogo(f.agent, f.teamA, pngBytes(), "image/png"))).toBe("forbidden");
    expect(await errorCode(removeTeamLogo(f.agent, f.teamA))).toBe("forbidden");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app.team_logos`;
    expect(n).toBe(0);
  });

  it("never exposes logo bytes to signed-in users and limits metadata and writes by RLS", async () => {
    const f = await setup();
    await uploadTeamLogo(f.teamAdminA, f.teamA, pngBytes(), "image/png");
    expect(await errorCode(withUser(f.teamAdminA.id, (tx) => tx`select bytes from app.team_logos`))).toBe("pg:42501");
    const own = await withUser(f.teamAdminA.id, (tx) => tx`select team_id, sha256 from app.team_logos`);
    expect(own).toHaveLength(1);
    const agentRows = await withUser(f.agent.id, (tx) => tx`select team_id from app.team_logos`);
    expect(agentRows).toHaveLength(0);
    const managerRows = await withUser(f.manager.id, (tx) => tx`select team_id from app.team_logos`);
    expect(managerRows).toHaveLength(1);
    const png = Buffer.from(pngBytes());
    expect(
      await errorCode(
        withUser(f.teamAdminB.id, (tx) => tx`
          insert into app.team_logos (team_id, content_type, bytes, sha256) values (${f.teamA}, 'image/png', ${png}, ${"b".repeat(64)})
        `),
      ),
    ).toBe("pg:42501");
    const del = await withUser(f.teamAdminB.id, (tx) => tx`delete from app.team_logos where team_id = ${f.teamA}`);
    expect(del.count).toBe(0);
    // SVG cannot be stored even by a direct insert.
    expect(
      await errorCode(sql`insert into app.team_logos (team_id, content_type, bytes, sha256) values (${f.teamB}, 'image/svg+xml', ${png}, ${"c".repeat(64)})`),
    ).toBe("pg:23514");
  });
});

describe("public branding", () => {
  it("returns public-safe branding with a contrast-checked accent", async () => {
    const f = await setup();
    await savePageSettings(f.teamAdminA, f.teamA, { displayName: "Acme", accentColor: "#FFFF00", heading: "Book with Acme", showBtcLogo: true });
    const up = await uploadTeamLogo(f.teamAdminA, f.teamA, pngBytes(400, 100), "image/png");
    const b = await getPartnerBranding(f.teamA);
    expect(b).toMatchObject({
      teamId: f.teamA,
      displayName: "Acme",
      heading: "Book with Acme",
      accentColor: brand.colors.primary,
      logoUrl: `/api/public/team-logo/${f.teamA}?v=${up.sha256.slice(0, 16)}`,
      logoWidth: 400,
      logoHeight: 100,
      showBtcLogo: true,
      showHostName: true,
    });
    expect(Object.keys(b!).sort()).not.toContain("page_settings");
    expect(await getPartnerBranding("00000000-0000-4000-8000-00000000abcd")).toBeNull();
    expect(await getPartnerBranding("nope")).toBeNull();
  });

  it("applies to team bookings only and hides hosts on the manage page when configured", async () => {
    const f = await setup();
    const host = await makeUser(sql, { name: "Hidden Host" });
    const [{ id: teamEventId }] = await sql<{ id: string }[]>`select id from app.event_types where team_id = ${f.teamA}`;
    const individualEventId = await makeIndividualEventType(sql, host.id);
    expect(await getPartnerBrandingForEventType(individualEventId)).toBeNull();
    expect((await getPartnerBrandingForEventType(teamEventId))?.teamId).toBe(f.teamA);

    await savePageSettings(f.teamAdminA, f.teamA, { showHostPhoto: false, showHostName: false });
    const start = new Date(Date.now() + 3 * 86_400_000);
    const bookingId = await makeBooking(sql, { eventTypeId: teamEventId, hosts: [{ userId: host.id }], start, end: new Date(start.getTime() + 1_800_000) });
    const token = randomBytes(32).toString("base64url");
    await sql`update app.bookings set manage_token_hash = ${sha256Hex(token)} where id = ${bookingId}`;

    const partner = await getPartnerBrandingForManageToken(token);
    expect(partner?.teamId).toBe(f.teamA);
    const view = await getBookingByToken(token);
    expect(view?.hosts.map((h) => h.name)).toEqual(["Hidden Host"]);
    expect(visibleHosts(view!.hosts, partner)).toEqual([]);

    await savePageSettings(f.teamAdminA, f.teamA, { showHostPhoto: false });
    expect(visibleHosts(view!.hosts, await getPartnerBrandingForManageToken(token))).toEqual([{ name: "Hidden Host", photoUrl: null, showAvatar: false }]);

    expect(await getPartnerBrandingForManageToken("short")).toBeNull();
    expect(await getPartnerBrandingForManageToken(randomBytes(32).toString("base64url"))).toBeNull();
  });
});

describe("partner name in notifications", () => {
  it("uses the branding display name when set and the team name otherwise", async () => {
    const { eventTypeId, teamId } = await makeTeamEventType(sql);
    const [team] = await sql<{ name: string }[]>`select name from app.teams where id = ${teamId}`;
    expect(await partnerNameForEventType(sql, eventTypeId)).toBe(team.name);
    await sql`update app.teams set page_settings = ${sql.json({ displayName: "Acme Funding" })} where id = ${teamId}`;
    expect(await partnerNameForEventType(sql, eventTypeId)).toBe("Acme Funding");
    const owner = await makeUser(sql);
    expect(await partnerNameForEventType(sql, await makeIndividualEventType(sql, owner.id))).toBeNull();
  });
});
