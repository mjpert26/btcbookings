import { describe, expect, it } from "vitest";
import { buildIcs, googleCalendarUrl, outlookCalendarUrl } from "@/server/booking/ics";
import { renderHostConflict, renderHostNotice, renderInviteeEmail } from "@/server/email/render";
import type { InviteeEmailData } from "@/server/email/templates/invitee";
import { translator } from "@/server/email/i18n";
import { formatWhen } from "@/server/email/format";
import en from "../../messages/en.json";
import es from "../../messages/es.json";

const start = new Date("2026-10-06T14:00:00Z");
const end = new Date("2026-10-06T14:30:00Z");
const TOKEN = "T".repeat(43);

const data = (over: Partial<InviteeEmailData> = {}): InviteeEmailData => ({
  locale: "en",
  inviteeName: "Pat Smith",
  eventName: "Funding consultation",
  start,
  end,
  timezone: "America/New_York",
  hostNames: ["Dana Host"],
  locationType: "teams",
  locationDetail: null,
  onlineMeetingUrl: null,
  manageUrl: `https://book.example.com/b/${TOKEN}`,
  bookAgainUrl: "https://book.example.com/dana/intro",
  logoUrl: "https://book.example.com/brand/btc-logo.png",
  ...over,
});

describe("ICS", () => {
  it("builds a UTC VEVENT with a stable UID and sequence", () => {
    const ics = buildIcs({ uid: "abc@btc-scheduler", sequence: 2, start, end, title: "Intro", location: "Teams", url: "https://x.test/b/1" });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("UID:abc@btc-scheduler");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("DTSTART:20261006T140000Z");
    expect(ics).toContain("DTEND:20261006T143000Z");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it("builds web calendar links", () => {
    expect(googleCalendarUrl({ title: "Intro", start, end })).toContain("dates=20261006T140000Z%2F20261006T143000Z");
    expect(outlookCalendarUrl({ title: "Intro", start, end })).toContain("startdt=2026-10-06T14%3A00%3A00.000Z");
  });
});

describe("email i18n", () => {
  it("has the same keys in every catalog", () => {
    const keys = (o: unknown, p = ""): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`],
      );
    expect(keys(es).sort()).toEqual(keys(en).sort());
  });

  it("interpolates and falls back to English", () => {
    const t = translator("es", "email");
    expect(t("greeting", { name: "Ana" })).toBe("Estimado(a) Ana:");
    expect(translator("fr", "email")("greeting", { name: "Al" })).toBe("Hello Al,");
  });

  it("formats in the reader's zone and locale", () => {
    expect(formatWhen(start, end, "America/New_York", "en")).toMatchObject({
      date: "Tuesday, October 6, 2026",
      time: "10:00 AM",
      range: "10:00 AM – 10:30 AM",
    });
    const es = formatWhen(start, end, "America/Bogota", "es");
    expect(es.date).toBe("martes, 6 de octubre de 2026");
    expect(es.time).toMatch(/^9:00/);
  });
});

describe("email rendering", () => {
  it("renders the English confirmation with the manage link as the only token", async () => {
    const r = await renderInviteeEmail("confirmed", data());
    expect(r.subject).toBe("Confirmed: Funding consultation on Tuesday, October 6, 2026");
    expect(r.html).toContain("Your meeting is confirmed");
    expect(r.html).toContain("10:00 AM – 10:30 AM");
    expect(r.html).toContain("Dana Host");
    expect(r.html).toContain("Reschedule or cancel");
    expect(r.html.split(TOKEN).length - 1).toBe(1);
    expect(r.text).toContain("Hello Pat Smith,");
  });

  it("renders Spanish with formal copy", async () => {
    const r = await renderInviteeEmail("reminder", data({ locale: "es" }));
    expect(r.subject).toBe("Recordatorio: Funding consultation el martes, 6 de octubre de 2026 a las 10:00 a.m.");
    expect(r.html).toContain("Su reunión se acerca");
    expect(r.html).toContain("Reprogramar o cancelar");
    expect(r.html).toContain('lang="es"');
  });

  it("omits the manage link on cancellations and offers to book again", async () => {
    const r = await renderInviteeEmail("cancelled", data());
    expect(r.html).not.toContain(TOKEN);
    expect(r.html).toContain("https://book.example.com/dana/intro");
    expect(r.html).toContain("Your meeting was cancelled");
  });

  it("shows the Teams link when known, and the location detail otherwise", async () => {
    const teams = await renderInviteeEmail("confirmed", data({ onlineMeetingUrl: "https://teams.microsoft.com/l/meetup-join/x" }));
    expect(teams.html).toContain("https://teams.microsoft.com/l/meetup-join/x");
    const phone = await renderInviteeEmail("confirmed", data({ locationType: "phone", locationDetail: "+1 305 555 0100" }));
    expect(phone.html).toContain("Phone call: +1 305 555 0100");
  });

  it("renders host-facing emails in English", async () => {
    const notice = await renderHostNotice({
      kind: "created",
      hostName: "Dana",
      eventName: "Intro",
      start,
      end,
      timezone: "America/Chicago",
      inviteeName: "Pat",
      inviteeEmail: "pat@example.com",
      inviteePhone: null,
      inviteeTimezone: "America/New_York",
      answers: [{ label: "Company", value: "Acme" }],
      cancelReason: null,
      dashboardUrl: "https://book.example.com/dashboard",
      logoUrl: "https://book.example.com/brand/btc-logo.png",
    });
    expect(notice.subject).toBe("New booking: Intro with Pat on Tuesday, October 6, 2026");
    expect(notice.html).toContain("Acme");
    expect(notice.html).toContain("9:00 AM – 9:30 AM");
    const flagged = await renderHostConflict({
      hostName: "Dana",
      eventName: "Intro",
      start,
      end,
      timezone: "America/Chicago",
      inviteeName: "Pat",
      reason: "The Outlook event was deleted.",
      dashboardUrl: "https://book.example.com/dashboard",
      logoUrl: "https://book.example.com/brand/btc-logo.png",
    });
    expect(flagged.subject).toMatch(/^Action needed: Intro with Pat/);
    expect(flagged.html).toContain("The Outlook event was deleted.");
  });
});
