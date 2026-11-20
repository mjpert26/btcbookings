import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { formatTimeOff, parseTimeOff, timeOffRange, TIME_OFF_NOTE_MAX } from "@/lib/time-off";
import { generateSlots } from "@/server/scheduling";
import { host, local, NY, schedule, settings, t } from "./scheduling-fixtures";

const NOW = DateTime.fromISO("2026-11-20T12:00:00Z").toMillis();
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function parse(input: Parameters<typeof parseTimeOff>[0], zone = NY, now = NOW) {
  return parseTimeOff(input, { zone, now });
}

describe("timeOffRange: form input to UTC", () => {
  it("covers one whole local day for a single all-day date", () => {
    const r = timeOffRange({ allDay: true, startDate: "2026-12-07", endDate: "2026-12-07" }, NY);
    expect(iso(r.startsAt)).toBe("2026-12-07T05:00:00.000Z");
    expect(iso(r.endsAt)).toBe("2026-12-08T05:00:00.000Z");
  });

  it("treats a missing end date as the start date", () => {
    const r = timeOffRange({ allDay: true, startDate: "2026-12-07", endDate: "" }, NY);
    expect(r.endsAt - r.startsAt).toBe(24 * HOUR);
  });

  it("covers every day of a multi-day all-day range through 24:00 on the end date", () => {
    const r = timeOffRange({ allDay: true, startDate: "2026-12-24", endDate: "2027-01-01" }, NY);
    expect(iso(r.startsAt)).toBe("2026-12-24T05:00:00.000Z");
    expect(iso(r.endsAt)).toBe("2027-01-02T05:00:00.000Z");
  });

  it("converts a same-day time window in the user's zone", () => {
    const r = timeOffRange({ allDay: false, startDate: "2026-12-07", startTime: "13:00", endTime: "15:30" }, NY);
    expect(iso(r.startsAt)).toBe("2026-12-07T18:00:00.000Z");
    expect(iso(r.endsAt)).toBe("2026-12-07T20:30:00.000Z");
  });

  it("converts a window that crosses midnight to the next date", () => {
    const r = timeOffRange({ allDay: false, startDate: "2026-12-07", endDate: "2026-12-08", startTime: "22:00", endTime: "02:00" }, NY);
    expect(iso(r.startsAt)).toBe("2026-12-08T03:00:00.000Z");
    expect(iso(r.endsAt)).toBe("2026-12-08T07:00:00.000Z");
  });

  it("uses a different zone when given one", () => {
    const r = timeOffRange({ allDay: true, startDate: "2026-12-07" }, "America/Los_Angeles");
    expect(iso(r.startsAt)).toBe("2026-12-07T08:00:00.000Z");
  });

  it("covers the whole 23-hour day when DST starts (America/New_York, 2027-03-14)", () => {
    const r = timeOffRange({ allDay: true, startDate: "2027-03-14" }, NY);
    expect(iso(r.startsAt)).toBe("2027-03-14T05:00:00.000Z");
    expect(iso(r.endsAt)).toBe("2027-03-15T04:00:00.000Z");
    expect(r.endsAt - r.startsAt).toBe(23 * HOUR);
  });

  it("covers the whole 25-hour day when DST ends (America/New_York, 2027-11-07)", () => {
    const r = timeOffRange({ allDay: true, startDate: "2027-11-07" }, NY);
    expect(iso(r.startsAt)).toBe("2027-11-07T04:00:00.000Z");
    expect(iso(r.endsAt)).toBe("2027-11-08T05:00:00.000Z");
    expect(r.endsAt - r.startsAt).toBe(25 * HOUR);
  });

  it("measures a time window across the DST start in real hours", () => {
    const r = timeOffRange({ allDay: false, startDate: "2027-03-14", startTime: "01:00", endTime: "04:00" }, NY);
    // 01:00 EST to 04:00 EDT is two real hours.
    expect(r.endsAt - r.startsAt).toBe(2 * HOUR);
  });

  it("resolves a start inside the DST gap to the transition instant", () => {
    const r = timeOffRange({ allDay: false, startDate: "2027-03-14", startTime: "02:30", endTime: "05:00" }, NY);
    expect(iso(r.startsAt)).toBe("2027-03-14T07:00:00.000Z");
  });

  it("resolves an ambiguous time on the DST end day to the earlier offset", () => {
    const r = timeOffRange({ allDay: false, startDate: "2027-11-07", startTime: "01:30", endTime: "03:00" }, NY);
    expect(iso(r.startsAt)).toBe("2027-11-07T05:30:00.000Z");
    expect(r.endsAt - r.startsAt).toBe(2.5 * HOUR);
  });
});

describe("parseTimeOff: validation", () => {
  it("accepts an all-day block and trims the note", () => {
    const res = parse({ allDay: true, startDate: "2026-12-07", endDate: "2026-12-09", note: "  Vacation  " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ allDay: true, timezone: NY, note: "Vacation" });
    expect(res.value.endsAt.getTime() - res.value.startsAt.getTime()).toBe(72 * HOUR);
  });

  it("stores an empty note as null", () => {
    const res = parse({ allDay: true, startDate: "2026-12-07", note: "" });
    expect(res.ok && res.value.note).toBeNull();
  });

  it("rejects an end date before the start date", () => {
    const res = parse({ allDay: true, startDate: "2026-12-09", endDate: "2026-12-07" });
    expect(res).toEqual({ ok: false, errors: { endDate: "The end date must be on or after the start date." } });
  });

  it("rejects a window whose end is not after its start", () => {
    expect(parse({ allDay: false, startDate: "2026-12-07", endDate: "2026-12-07", startTime: "15:00", endTime: "15:00" })).toEqual({
      ok: false,
      errors: { endTime: "The end must be after the start." },
    });
    // With no end date, suggest choosing one for a window that runs past midnight.
    expect(parse({ allDay: false, startDate: "2026-12-07", startTime: "15:00", endTime: "09:00" })).toEqual({
      ok: false,
      errors: { endTime: "The end must be after the start. To end after midnight, choose an end date." },
    });
  });

  it("puts an end date before the start date on the end date field for a time window", () => {
    expect(parse({ allDay: false, startDate: "2026-12-10", endDate: "2026-12-09", startTime: "09:00", endTime: "17:00" })).toEqual({
      ok: false,
      errors: { endDate: "The end date must be on or after the start date." },
    });
  });

  it("requires times for a time window and valid dates", () => {
    const res = parse({ allDay: false, startDate: "2026-13-40", startTime: "", endTime: "25:00" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The end date is optional, so an empty one is not flagged.
    expect(Object.keys(res.errors).sort()).toEqual(["endTime", "startDate", "startTime"]);
  });

  it("flags only the start date when both dates are empty", () => {
    expect(parse({ allDay: true, startDate: "", endDate: "" })).toEqual({ ok: false, errors: { startDate: "Choose a start date." } });
  });

  it("flags a typed end date that is not a valid date", () => {
    expect(parse({ allDay: true, startDate: "2026-12-07", endDate: "2026-02-31" })).toEqual({
      ok: false,
      errors: { endDate: "Enter a valid end date." },
    });
  });

  it("rejects a block that has already ended", () => {
    expect(parse({ allDay: true, startDate: "2026-11-19" })).toEqual({ ok: false, errors: { endDate: "This time off has already ended." } });
    expect(parse({ allDay: false, startDate: "2026-11-20", startTime: "05:00", endTime: "06:00" }).ok).toBe(false);
  });

  it("accepts a block that started earlier today and has not ended", () => {
    // NOW is 07:00 in New York on 2026-11-20.
    expect(parse({ allDay: true, startDate: "2026-11-20" }).ok).toBe(true);
    expect(parse({ allDay: false, startDate: "2026-11-20", startTime: "06:00", endTime: "08:00" }).ok).toBe(true);
  });

  it("accepts 366 days and rejects anything longer", () => {
    expect(parse({ allDay: true, startDate: "2026-12-01", endDate: "2027-12-01" }).ok).toBe(true);
    expect(parse({ allDay: true, startDate: "2026-12-01", endDate: "2027-12-02" })).toEqual({
      ok: false,
      errors: { endDate: "Time off can last at most 366 days." },
    });
  });

  it("limits the note to 200 characters", () => {
    expect(parse({ allDay: true, startDate: "2026-12-07", note: "x".repeat(TIME_OFF_NOTE_MAX) }).ok).toBe(true);
    expect(parse({ allDay: true, startDate: "2026-12-07", note: "x".repeat(TIME_OFF_NOTE_MAX + 1) })).toEqual({
      ok: false,
      errors: { note: "Keep the note to 200 characters or fewer." },
    });
  });

  it("rejects an unknown time zone", () => {
    const res = parse({ allDay: true, startDate: "2026-12-07" }, "Mars/Base");
    expect(res.ok).toBe(false);
  });
});

describe("formatTimeOff", () => {
  const block = (startsAt: number, endsAt: number, allDay: boolean) => ({
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    allDay,
    timezone: NY,
  });

  it("shows a single all-day date", () => {
    const r = timeOffRange({ allDay: true, startDate: "2026-12-07" }, NY);
    expect(formatTimeOff(block(r.startsAt, r.endsAt, true))).toBe("Mon, Dec 7, 2026 (all day)");
  });

  it("shows the last day off, not the stored end, for an all-day range", () => {
    const r = timeOffRange({ allDay: true, startDate: "2026-12-07", endDate: "2026-12-11" }, NY);
    expect(formatTimeOff(block(r.startsAt, r.endsAt, true))).toBe("Mon, Dec 7 – Fri, Dec 11, 2026 (all day)");
  });

  it("shows a time window", () => {
    const r = timeOffRange({ allDay: false, startDate: "2026-12-07", startTime: "13:00", endTime: "15:00" }, NY);
    expect(formatTimeOff(block(r.startsAt, r.endsAt, false))).toBe("Mon, Dec 7, 2026, 1:00 PM – 3:00 PM EST");
  });
});

describe("generateSlots with time off", () => {
  const sched = schedule(NY, { mon: [{ start: "09:00", end: "12:00" }] });
  const now = t("2026-12-06T08:00");
  const to = t("2026-12-08T00:00");

  it("removes slots that overlap a time-off block, whatever the showAs settings", () => {
    const h = host("a", { unavailableShowAs: [], timeOff: [{ start: t("2026-12-07T10:00"), end: t("2026-12-07T11:00") }] });
    const slots = generateSlots({ mode: "individual", settings: settings({ schedule: sched }), hosts: [h], now, to });
    expect(slots.map((s) => local(s.start))).toEqual(["2026-12-07T09:00", "2026-12-07T09:30", "2026-12-07T11:00", "2026-12-07T11:30"]);
  });

  it("applies buffers against time off like a busy event", () => {
    const h = host("a", { timeOff: [{ start: t("2026-12-07T10:00"), end: t("2026-12-07T11:00") }] });
    const slots = generateSlots({ mode: "individual", settings: settings({ schedule: sched, bufferAfterMin: 15 }), hosts: [h], now, to });
    expect(slots.map((s) => local(s.start))).toEqual(["2026-12-07T09:00", "2026-12-07T11:00", "2026-12-07T11:30"]);
  });

  it("skips a round-robin host on time off and empties a collective page", () => {
    const off = host("a", { timeOff: [{ start: t("2026-12-07T00:00"), end: t("2026-12-08T00:00") }] });
    const free = host("b");
    const rr = generateSlots({ mode: "round_robin", settings: settings({ schedule: sched }), hosts: [off, free], now, to });
    expect(rr).toHaveLength(6);
    expect(rr.every((s) => s.freeHostIds.length === 1 && s.freeHostIds[0] === "b")).toBe(true);
    const collective = generateSlots({ mode: "collective", settings: settings({ schedule: sched }), hosts: [off, free], now, to });
    expect(collective).toEqual([]);
  });
});
