import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, makeUser, truncateAll } from "../helpers/db";
import { makeEvent, makeHost, makeTeam } from "../helpers/booking-flow-fixtures";
import type { Sql } from "@/server/db/client";
import type { SessionUser } from "@/server/auth/session";

// Server actions read the signed-in user, request headers and the cache; stand those in.
const current = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUser: async () => current.user,
  requireAdmin: async () => current.user,
  requireCapability: async () => current.user,
}));

const { updateEventTypeAction } = await import("@/app/(app)/event-types/_actions");
const { saveSettingsAction, saveWeeklyAction, addOverrideAction } = await import("@/app/(app)/availability/_actions");
const { saveTeamSettingsAction, updateMemberAction } = await import("@/app/(app)/teams/_actions");
const { saveSfSettings } = await import("@/server/salesforce/admin");
const { setTeamSyncSettings } = await import("@/server/sync/admin");

let sql: Sql;
beforeAll(() => {
  sql = connectTestDb(10);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
});

function signIn(u: { id: string; email: string }, role: SessionUser["role"] = "user") {
  current.user = { id: u.id, email: u.email, name: "Signed In", slug: "signed-in", role, timezone: "America/New_York", languages: ["en"], photoUrl: null, calendarStatus: "healthy" };
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  return fd;
}

type Row = { action: string; entity_id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; ip_hash: string | null; via: string | null };
async function audits(action: string): Promise<Row[]> {
  return sql<Row[]>`select action, entity_id, before, after, ip_hash, via from app.audit_log where action = ${action} order by created_at, id`;
}

const IDLE = { status: "idle" } as never;

function eventForm(over: Record<string, string | string[]> = {}) {
  return form({
    name: "Intro call",
    slug: "intro",
    descriptionEn: "A short intro call.",
    descriptionEs: "",
    durations: ["30"],
    defaultDuration: "30",
    locationType: "teams",
    locationDetail: "",
    scheduleId: "",
    bufferBefore: "0",
    bufferAfter: "0",
    minNotice: "0",
    maxPerDay: "",
    bookingWindowDays: "60",
    slotInterval: "",
    reminders: ["1440", "60"],
    isActive: "on",
    isListed: "on",
    brandAccent: "",
    questions: "[]",
    hosts: "[]",
    ...over,
  });
}

describe("settings changes record only the changed fields", () => {
  it("event type editor: one field, then a new booking question", async () => {
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id }, { slug: "intro", name: "Intro call" });
    await sql`update app.event_types set booking_window_days = 60 where id = ${ev.id}`;
    signIn(host);

    expect(await updateEventTypeAction(ev.id, IDLE, eventForm())).toMatchObject({ status: "success" });
    expect(await audits("event_type.update")).toHaveLength(0);

    expect(await updateEventTypeAction(ev.id, IDLE, eventForm({ name: "Discovery call", bufferAfter: "15" }))).toMatchObject({ status: "success" });
    let rows = await audits("event_type.update");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_id: ev.id,
      via: "web",
      before: { name: "Intro call", buffer_after_min: 0 },
      after: { name: "Discovery call", buffer_after_min: 15 },
    });
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);

    const questions = JSON.stringify([{ key: "company", type: "text", label: { en: "Company", es: "" }, required: true, options: [] }]);
    await updateEventTypeAction(ev.id, IDLE, eventForm({ name: "Discovery call", bufferAfter: "15", questions }));
    rows = await audits("event_type.update");
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[1].after!)).toEqual(["questions"]);
    expect(rows[1].before).toEqual({ questions: {} });
    expect(rows[1].after).toMatchObject({ questions: { company: { type: "text", required: true, label: { en: "Company" } } } });
  });

  it("booking preferences: SMS numbers are stored masked", async () => {
    const host = await makeHost(sql);
    signIn(host);
    const prefs = (over: Record<string, string> = {}) =>
      form({ unavailableShowAs: ["busy", "oof"], dailyBookingCap: "", outlookConflictPolicy: "flag", smsPhone: "", ...over });

    await saveSettingsAction(IDLE, prefs());
    await saveSettingsAction(IDLE, prefs({ smsPhone: "(312) 864-4567", dailyBookingCap: "6" }));
    const rows = await audits("user_settings.update");
    const last = rows[rows.length - 1];
    expect(last.before).toEqual({ daily_booking_cap: null, sms_phone: null });
    expect(last.after).toEqual({ daily_booking_cap: 6, sms_phone: "***-4567" });
    expect(JSON.stringify(rows)).not.toContain("3128644567");
    expect(JSON.stringify(rows)).not.toContain("864");
  });

  it("availability: weekly hours and date overrides", async () => {
    const host = await makeHost(sql, { timezone: "America/New_York" });
    signIn(host);
    const weekly = { mon: [{ start: "09:00", end: "17:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(await saveWeeklyAction(IDLE, form({ timezone: "America/New_York", weekly: JSON.stringify(weekly) }))).toMatchObject({ status: "success" });
    const [w] = await audits("availability.weekly_update");
    expect(Object.keys(w.after!)).toEqual(["weekly_rules"]);
    expect(w.entity_id).toBe(host.scheduleId);

    await addOverrideAction(IDLE, form({ date: "2026-11-27", intervals: "[]" }));
    const [o] = await audits("availability.override_set");
    expect(o).toMatchObject({ before: { "2026-11-27": null }, after: { "2026-11-27": [] } });
  });

  it("team settings and member settings", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const member = await makeHost(sql);
    const team = await makeTeam(sql, [member.id]);
    signIn(admin, "admin");
    await saveTeamSettingsAction(team.id, IDLE, form({ outlookConflictPolicy: "auto_cancel", removalPolicy: "keep_bookings", massRemovalThresholdPct: "50" }));
    const [t] = await audits("team.settings_update");
    expect(t).toMatchObject({ before: { outlook_conflict_policy: "flag" }, after: { outlook_conflict_policy: "auto_cancel" } });
    expect(Object.keys(t.after!)).toEqual(["outlook_conflict_policy"]);

    await updateMemberAction(team.id, IDLE, form({ memberId: team.memberIds[member.id], weight: "250", priorityTier: "1", dailyCap: "" }));
    const [m] = await audits("team.member_update");
    expect(m).toMatchObject({ before: { weight: 1 }, after: { weight: 250 } });
    expect(Object.keys(m.after!)).toEqual(["weight"]);
  });

  it("Salesforce and queue sync settings", async () => {
    const admin = await makeUser(sql, { role: "admin" });
    const host = await makeHost(sql);
    const ev = await makeEvent(sql, { userId: host.id });
    const base = { createSfLead: false, isoAccountId: null, fieldMapping: {}, staticValues: {}, campaignId: null, ownerMode: "assigned_host" as const };
    await saveSfSettings(admin, ev.id, base);
    await saveSfSettings(admin, ev.id, { ...base, createTask: true });
    const sf = await audits("sf_settings.update");
    expect(sf).toHaveLength(2);
    expect(sf[1].before).toEqual({ createTask: false });
    expect(sf[1].after).toEqual({ createTask: true });

    const team = await makeTeam(sql, []);
    const actor = { id: admin.id, role: "admin" as const };
    await setTeamSyncSettings(actor, team.id, { massRemovalThresholdPct: 25 });
    await setTeamSyncSettings(actor, team.id, { massRemovalThresholdPct: 25 });
    const sync = await audits("team.sync_settings.update");
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ before: { massRemovalThresholdPct: 50 }, after: { massRemovalThresholdPct: 25 } });
    expect(Object.keys(sync[0].after!)).toEqual(["massRemovalThresholdPct"]);
  });
});
