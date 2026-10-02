import { describe, expect, it } from "vitest";
import {
  defaultSlotInterval,
  expandSchedule,
  generateSlots,
  localToInstant,
} from "@/server/scheduling";
import type { GenerateSlotsInput, Slot } from "@/server/scheduling";
import { LA, NY, host, local, schedule, settings, t, weekdays } from "./scheduling-fixtures";

const HOUR = 3_600_000;
const MIN = 60_000;

/** Sunday 2026-10-04 12:00 New York: the following week is fully in the future. */
const SUNDAY_NOON = t("2026-10-04T12:00");

function run(patch: Partial<GenerateSlotsInput> = {}): Slot[] {
  return generateSlots({
    mode: "individual",
    settings: settings(),
    hosts: [host("u1")],
    now: SUNDAY_NOON,
    ...patch,
  });
}

/** Local start times (HH:mm) of slots on a local date. */
function onDate(slots: Slot[], date: string, zone = NY): string[] {
  return slots
    .map((s) => local(s.start, zone))
    .filter((l) => l.startsWith(date))
    .map((l) => l.slice(11));
}

function assertSortedUnique(slots: Slot[]) {
  for (let i = 1; i < slots.length; i++) expect(slots[i].start).toBeGreaterThan(slots[i - 1].start);
}

describe("defaultSlotInterval", () => {
  it("uses the explicit interval, else the duration with a 15 minute minimum", () => {
    expect(defaultSlotInterval(30, 20)).toBe(20);
    expect(defaultSlotInterval(45, null)).toBe(45);
    expect(defaultSlotInterval(10, null)).toBe(15);
  });
});

describe("basic expansion", () => {
  it("produces 9:30 to 18:00 starts on a weekday in New York", () => {
    const slots = run();
    const monday = onDate(slots, "2026-10-05");
    expect(monday).toHaveLength(18);
    expect(monday[0]).toBe("09:30");
    expect(monday.at(-1)).toBe("18:00");
    expect(onDate(slots, "2026-10-10")).toEqual([]); // Saturday
    const first = slots.find((s) => local(s.start).startsWith("2026-10-05"))!;
    expect(new Date(first.start).toISOString()).toBe("2026-10-05T13:30:00.000Z");
    expect(first.end - first.start).toBe(30 * MIN);
    expect(first.freeHostIds).toEqual(["u1"]);
    assertSortedUnique(slots);
  });

  it("respects a different duration and step", () => {
    const slots = run({ settings: settings({ durationMin: 60, slotIntervalMin: 15 }) });
    const monday = onDate(slots, "2026-10-05");
    expect(monday[0]).toBe("09:30");
    expect(monday[1]).toBe("09:45");
    expect(monday.at(-1)).toBe("17:30"); // 17:30 + 60 = 18:30
    expect(monday).toHaveLength(33);
  });

  it("evaluates a Los Angeles schedule in its own zone", () => {
    const slots = run({ settings: settings({ schedule: weekdays(LA) }) });
    const first = slots.find((s) => local(s.start, LA).startsWith("2026-10-05"))!;
    expect(new Date(first.start).toISOString()).toBe("2026-10-05T16:30:00.000Z");
    // The same instants read in New York are three hours later.
    expect(onDate(slots, "2026-10-05", NY)[0]).toBe("12:30");
    expect(onDate(slots, "2026-10-05", LA)).toHaveLength(18);
  });

  it("returns instants independent of the invitee's zone (display only)", () => {
    const slots = run();
    const tokyo = onDate(slots, "2026-10-05", "Asia/Tokyo");
    // Monday 9:30 New York is Monday 22:30 Tokyo.
    expect(tokyo[0]).toBe("22:30");
  });

  it("deduplicates overlapping weekly intervals", () => {
    const sched = schedule(NY, {
      mon: [
        { start: "09:00", end: "12:00" },
        { start: "10:00", end: "13:00" },
      ],
    });
    const slots = run({ settings: settings({ schedule: sched }) });
    const monday = onDate(slots, "2026-10-05");
    expect(monday).toHaveLength(8); // 09:00 .. 12:30
    expect(new Set(monday).size).toBe(monday.length);
    assertSortedUnique(slots);
  });

  it("steps from each interval start for split days", () => {
    const sched = schedule(NY, {
      mon: [
        { start: "09:00", end: "10:00" },
        { start: "13:15", end: "14:15" },
      ],
    });
    const slots = run({ settings: settings({ schedule: sched }) });
    expect(onDate(slots, "2026-10-05")).toEqual(["09:00", "09:30", "13:15", "13:45"]);
  });

  it("supports 24:00 as the end of the day", () => {
    const sched = schedule(NY, { mon: [{ start: "23:00", end: "24:00" }] });
    const slots = run({ settings: settings({ schedule: sched }) });
    expect(onDate(slots, "2026-10-05")).toEqual(["23:00", "23:30"]);
  });

  it("restricts to from/to", () => {
    const slots = run({ from: t("2026-10-06T00:00"), to: t("2026-10-07T00:00") });
    expect(slots).toHaveLength(18);
    expect(slots.every((s) => local(s.start).startsWith("2026-10-06"))).toBe(true);
  });
});

describe("DST transitions 2026 (America/New_York)", () => {
  it("spring forward: a 9:30 to 18:30 day is nine real hours", () => {
    const sched = schedule(NY, {}, [{ date: "2026-03-08", intervals: [{ start: "09:30", end: "18:30" }] }]);
    const slots = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-03-01T12:00"),
    });
    expect(slots).toHaveLength(18);
    expect(slots.at(-1)!.end - slots[0].start).toBe(9 * HOUR);
    expect(new Date(slots[0].start).toISOString()).toBe("2026-03-08T13:30:00.000Z"); // EDT
  });

  it("spring forward: a 01:00 to 03:30 rule skips the nonexistent hour", () => {
    const sched = schedule(NY, { sun: [{ start: "01:00", end: "03:30" }] });
    const slots = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-03-07T12:00"),
      to: t("2026-03-09T00:00"),
    });
    expect(slots.map((s) => new Date(s.start).toISOString())).toEqual([
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T06:30:00.000Z", // 01:30 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT
    ]);
    expect(onDate(slots, "2026-03-08")).toEqual(["01:00", "01:30", "03:00"]);
    expect(slots.every((s) => !local(s.start).slice(11).startsWith("02"))).toBe(true);
  });

  it("spring forward: a rule entirely inside the gap yields nothing", () => {
    const sched = schedule(NY, { sun: [{ start: "02:00", end: "02:45" }] });
    const slots = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched, durationMin: 15, slotIntervalMin: 15 }),
      hosts: [host("u1")],
      now: t("2026-03-07T12:00"),
      to: t("2026-03-09T00:00"),
    });
    expect(slots).toEqual([]);
  });

  it("spring forward: a rule starting inside the gap starts at the transition", () => {
    expect(new Date(localToInstant("2026-03-08", "02:30", NY)).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    const sched = schedule(NY, { sun: [{ start: "02:30", end: "04:00" }] });
    const slots = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-03-07T12:00"),
      to: t("2026-03-09T00:00"),
    });
    expect(onDate(slots, "2026-03-08")).toEqual(["03:00", "03:30"]);
  });

  it("fall back: a 9:30 to 18:30 day is nine real hours", () => {
    const sched = schedule(NY, { sun: [{ start: "09:30", end: "18:30" }] });
    const slots = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-10-31T12:00"),
      to: t("2026-11-02T00:00"),
    });
    expect(slots).toHaveLength(18);
    expect(slots.at(-1)!.end - slots[0].start).toBe(9 * HOUR);
    expect(new Date(slots[0].start).toISOString()).toBe("2026-11-01T14:30:00.000Z"); // EST
  });

  it("fall back: a 01:00 to 03:30 rule covers the repeated hour once each, without duplicates", () => {
    const sched = schedule(NY, { sun: [{ start: "01:00", end: "03:30" }] });
    const slots = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-10-31T12:00"),
      to: t("2026-11-02T00:00"),
    });
    // 01:00 EDT (05:00Z) to 03:30 EST (08:30Z) is 3.5 real hours.
    expect(slots.map((s) => new Date(s.start).toISOString())).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ]);
    assertSortedUnique(slots);
  });

  it("weekly rules shift UTC across the transition", () => {
    const slots = generateSlots({
      mode: "individual",
      settings: settings(),
      hosts: [host("u1")],
      now: t("2026-10-30T12:00"),
      to: t("2026-11-03T00:00"),
    });
    const fri = slots.find((s) => local(s.start).startsWith("2026-10-30T15:00"))!;
    const mon = slots.find((s) => local(s.start).startsWith("2026-11-02T09:30"))!;
    expect(new Date(fri.start).toISOString()).toBe("2026-10-30T19:00:00.000Z"); // EDT
    expect(new Date(mon.start).toISOString()).toBe("2026-11-02T14:30:00.000Z"); // EST
    expect(onDate(slots, "2026-11-02")).toHaveLength(18);
  });

  it("a Los Angeles schedule with a New York host stays consistent across both transitions", () => {
    const sched = schedule(LA, { sun: [{ start: "01:00", end: "03:30" }] });
    const spring = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-03-07T12:00", LA),
      to: t("2026-03-09T00:00", LA),
    });
    expect(onDate(spring, "2026-03-08", LA)).toEqual(["01:00", "01:30", "03:00"]);
    const fall = generateSlots({
      mode: "individual",
      settings: settings({ schedule: sched }),
      hosts: [host("u1")],
      now: t("2026-10-31T12:00", LA),
      to: t("2026-11-02T00:00", LA),
    });
    expect(fall).toHaveLength(7);
  });
});

describe("buffers and busy blocks", () => {
  const busy = (start: string, end: string, showAs = "busy", isAllDay = false) => ({
    start: t(start),
    end: t(end),
    showAs,
    isAllDay,
  });

  it("adjacent busy blocks do not block neighbors without buffers", () => {
    const slots = run({ hosts: [host("u1", { busy: [busy("2026-10-05T10:00", "2026-10-05T11:00")] })] });
    const monday = onDate(slots, "2026-10-05");
    expect(monday).toContain("09:30");
    expect(monday).not.toContain("10:00");
    expect(monday).not.toContain("10:30");
    expect(monday).toContain("11:00");
  });

  it("buffers extend the blocked range on both sides", () => {
    const slots = run({
      settings: settings({ bufferBeforeMin: 15, bufferAfterMin: 15 }),
      hosts: [host("u1", { busy: [busy("2026-10-05T10:00", "2026-10-05T11:00")] })],
    });
    const monday = onDate(slots, "2026-10-05");
    expect(monday).not.toContain("09:30"); // 09:15-10:15 overlaps
    expect(monday).not.toContain("11:00"); // 10:45-11:45 overlaps
    expect(monday[0]).toBe("11:30");
  });

  it("buffer after only affects the following side", () => {
    const slots = run({
      settings: settings({ bufferAfterMin: 15 }),
      hosts: [host("u1", { busy: [busy("2026-10-05T10:00", "2026-10-05T11:00")] })],
    });
    const monday = onDate(slots, "2026-10-05");
    expect(monday).not.toContain("09:30"); // 09:30-10:15 overlaps
    expect(monday).toContain("11:00");
  });

  it("existing booked ranges block like busy time", () => {
    const slots = run({
      hosts: [host("u1", { booked: [{ start: t("2026-10-05T12:00"), end: t("2026-10-05T12:45") }] })],
    });
    const monday = onDate(slots, "2026-10-05");
    expect(monday).not.toContain("12:00");
    expect(monday).not.toContain("12:30");
    expect(monday).toContain("13:00");
  });

  it("merges overlapping busy blocks and respects adjacent ones", () => {
    const slots = run({
      hosts: [
        host("u1", {
          busy: [
            busy("2026-10-05T10:00", "2026-10-05T10:45"),
            busy("2026-10-05T10:30", "2026-10-05T11:00"),
            busy("2026-10-05T11:00", "2026-10-05T11:30"),
            busy("2026-10-05T10:10", "2026-10-05T10:20"),
          ],
        }),
      ],
    });
    const monday = onDate(slots, "2026-10-05");
    expect(monday.slice(0, 2)).toEqual(["09:30", "11:30"]);
  });

  it("applies the host's unavailable showAs set", () => {
    const blocks = [
      busy("2026-10-05T09:30", "2026-10-05T10:00", "tentative"),
      busy("2026-10-05T10:00", "2026-10-05T10:30", "oof"),
      busy("2026-10-05T10:30", "2026-10-05T11:00", "free"),
      busy("2026-10-05T11:00", "2026-10-05T11:30", "workingElsewhere"),
      busy("2026-10-05T11:30", "2026-10-05T12:00", "unknown"),
      busy("2026-10-05T12:00", "2026-10-05T12:30", "busy"),
    ];
    const defaults = onDate(run({ hosts: [host("u1", { busy: blocks })] }), "2026-10-05");
    expect(defaults.slice(0, 4)).toEqual(["10:30", "11:00", "11:30", "12:30"]);

    const onlyBusy = onDate(
      run({ hosts: [host("u1", { busy: blocks, unavailableShowAs: ["busy"] })] }),
      "2026-10-05",
    );
    expect(onlyBusy.slice(0, 6)).toEqual(["09:30", "10:00", "10:30", "11:00", "11:30", "12:30"]);

    const strict = onDate(
      run({
        hosts: [
          host("u1", {
            busy: blocks,
            unavailableShowAs: ["busy", "tentative", "oof", "workingElsewhere", "unknown"],
          }),
        ],
      }),
      "2026-10-05",
    );
    expect(strict[0]).toBe("10:30");
    expect(strict[1]).toBe("12:30");
  });

  it("all-day busy events block the host's local day; all-day free events never block", () => {
    const allDay = (showAs: string) => [busy("2026-10-06T00:00", "2026-10-07T00:00", showAs, true)];
    const oof = run({ hosts: [host("u1", { busy: allDay("oof") })] });
    expect(onDate(oof, "2026-10-06")).toEqual([]);
    expect(onDate(oof, "2026-10-05")).toHaveLength(18);
    expect(onDate(oof, "2026-10-07")).toHaveLength(18);

    const free = run({ hosts: [host("u1", { busy: allDay("free") })] });
    expect(onDate(free, "2026-10-06")).toHaveLength(18);

    const elsewhere = run({ hosts: [host("u1", { busy: allDay("workingElsewhere") })] });
    expect(onDate(elsewhere, "2026-10-06")).toHaveLength(18);
  });

  it("multi-day all-day events block every covered day", () => {
    const slots = run({
      hosts: [host("u1", { busy: [busy("2026-10-06T00:00", "2026-10-09T00:00", "oof", true)] })],
    });
    expect(onDate(slots, "2026-10-06")).toEqual([]);
    expect(onDate(slots, "2026-10-08")).toEqual([]);
    expect(onDate(slots, "2026-10-09")).toHaveLength(18);
  });
});

describe("notice and window", () => {
  it("drops slots before now + minimum notice", () => {
    const slots = run({ now: t("2026-10-05T10:05"), settings: settings({ minNoticeMin: 60 }) });
    expect(onDate(slots, "2026-10-05")[0]).toBe("11:30");
  });

  it("includes a slot exactly at now + minimum notice", () => {
    const slots = run({ now: t("2026-10-05T10:00"), settings: settings({ minNoticeMin: 60 }) });
    expect(onDate(slots, "2026-10-05")[0]).toBe("11:00");
  });

  it("minimum notice can push into the next day", () => {
    const slots = run({ now: t("2026-10-05T17:00"), settings: settings({ minNoticeMin: 240 }) });
    expect(onDate(slots, "2026-10-05")).toEqual([]);
    expect(onDate(slots, "2026-10-06")).toHaveLength(18);
  });

  it("includes the whole last local day of the booking window and nothing after", () => {
    const slots = run({ now: t("2026-10-05T10:00"), settings: settings({ bookingWindowDays: 2 }) });
    expect(onDate(slots, "2026-10-07")).toHaveLength(18);
    expect(onDate(slots, "2026-10-08")).toEqual([]);
    expect(local(slots.at(-1)!.start)).toBe("2026-10-07T18:00");
  });

  it("evaluates the window end in the schedule's zone", () => {
    // 23:30 New York on Monday is already Tuesday in UTC; the window still ends Wednesday NY.
    const sched = schedule(NY, { wed: [{ start: "23:00", end: "24:00" }], thu: [{ start: "00:00", end: "01:00" }] });
    const slots = run({ now: t("2026-10-05T23:30"), settings: settings({ bookingWindowDays: 2, schedule: sched }) });
    expect(slots.map((s) => local(s.start))).toEqual(["2026-10-07T23:00", "2026-10-07T23:30"]);
  });
});

describe("overrides and host schedules", () => {
  it("a closed override removes the day", () => {
    const slots = run({ settings: settings({ schedule: weekdays(NY, [{ date: "2026-10-06", intervals: [] }]) }) });
    expect(onDate(slots, "2026-10-06")).toEqual([]);
    expect(onDate(slots, "2026-10-07")).toHaveLength(18);
  });

  it("a custom-hours override replaces the weekly rule", () => {
    const sched = weekdays(NY, [{ date: "2026-10-06", intervals: [{ start: "12:00", end: "14:00" }] }]);
    const slots = run({ settings: settings({ schedule: sched }) });
    expect(onDate(slots, "2026-10-06")).toEqual(["12:00", "12:30", "13:00", "13:30"]);
  });

  it("an override can open a weekend day", () => {
    const sched = weekdays(NY, [{ date: "2026-10-10", intervals: [{ start: "10:00", end: "11:00" }] }]);
    const slots = run({ settings: settings({ schedule: sched }) });
    expect(onDate(slots, "2026-10-10")).toEqual(["10:00", "10:30"]);
  });

  it("intersects the event schedule with the host's own schedule", () => {
    // Host works 9:00-17:00 Los Angeles = 12:00-20:00 New York.
    const hostSched = weekdays(LA);
    hostSched.weekly.mon = [{ start: "09:00", end: "17:00" }];
    const slots = run({ hosts: [host("u1", { timezone: LA, schedule: hostSched })] });
    const monday = onDate(slots, "2026-10-05");
    expect(monday[0]).toBe("12:00");
    expect(monday.at(-1)).toBe("18:00");
    expect(monday).toHaveLength(13);
  });

  it("a host schedule override closes that host's day", () => {
    const hostSched = weekdays(NY, [{ date: "2026-10-06", intervals: [] }]);
    const slots = run({ hosts: [host("u1", { schedule: hostSched })] });
    expect(onDate(slots, "2026-10-06")).toEqual([]);
    expect(onDate(slots, "2026-10-05")).toHaveLength(18);
  });

  it("expandSchedule returns ranges for each local date", () => {
    const ranges = expandSchedule(weekdays(), t("2026-10-05T00:00"), t("2026-10-07T00:00"));
    const inWindow = ranges.filter((r) => r.start >= t("2026-10-05T00:00") && r.start < t("2026-10-07T00:00"));
    expect(inWindow).toHaveLength(2);
    expect(inWindow[0].end - inWindow[0].start).toBe(9 * HOUR);
  });
});

describe("caps", () => {
  it("drops a host at the daily cap for that local day", () => {
    const slots = run({ hosts: [host("u1", { dailyCap: 3, bookingsPerDay: { "2026-10-06": 3 } })] });
    expect(onDate(slots, "2026-10-06")).toEqual([]);
    expect(onDate(slots, "2026-10-05")).toHaveLength(18);
    const under = run({ hosts: [host("u1", { dailyCap: 3, bookingsPerDay: { "2026-10-06": 2 } })] });
    expect(onDate(under, "2026-10-06")).toHaveLength(18);
  });

  it("counts the daily cap in the host's zone", () => {
    // Tuesday 11:00 New York is 00:00 Wednesday in Tokyo.
    const slots = run({
      hosts: [host("u1", { timezone: "Asia/Tokyo", dailyCap: 1, bookingsPerDay: { "2026-10-07": 1 } })],
    });
    const tuesday = onDate(slots, "2026-10-06");
    expect(tuesday).toEqual(["09:30", "10:00", "10:30"]);
    // Wednesday NY morning is still Wednesday in Tokyo (capped); from 11:00 it is Thursday.
    expect(onDate(slots, "2026-10-07")[0]).toBe("11:00");
    expect(onDate(slots, "2026-10-07")).toHaveLength(15);
  });

  it("applies the event type max per day per host", () => {
    const slots = run({
      settings: settings({ maxPerDay: 2 }),
      eventBookingsPerDay: { u1: { "2026-10-06": 2 } },
    });
    expect(onDate(slots, "2026-10-06")).toEqual([]);
    expect(onDate(slots, "2026-10-07")).toHaveLength(18);
  });

  it("max per day drops only the capped host in round-robin", () => {
    const slots = run({
      mode: "round_robin",
      settings: settings({ maxPerDay: 1 }),
      hosts: [host("a"), host("b")],
      eventBookingsPerDay: { a: { "2026-10-06": 1 } },
    });
    const tue = slots.filter((s) => local(s.start).startsWith("2026-10-06"));
    expect(tue).toHaveLength(18);
    expect(tue.every((s) => s.freeHostIds.join() === "b")).toBe(true);
  });
});

describe("modes", () => {
  const busyMorning = [{ start: t("2026-10-05T09:30"), end: t("2026-10-05T12:00"), showAs: "busy", isAllDay: false }];
  const busyAfternoon = [{ start: t("2026-10-05T12:00"), end: t("2026-10-05T18:30"), showAs: "busy", isAllDay: false }];

  it("individual requires the owner to be free and eligible", () => {
    expect(run({ hosts: [host("u1", { eligible: false })] })).toEqual([]);
    expect(run({ hosts: [] })).toEqual([]);
  });

  it("round-robin needs any eligible host and lists the free ones", () => {
    const slots = run({
      mode: "round_robin",
      hosts: [host("a", { busy: busyMorning }), host("b", { busy: busyAfternoon }), host("c", { eligible: false })],
    });
    const monday = slots.filter((s) => local(s.start).startsWith("2026-10-05"));
    expect(monday).toHaveLength(18);
    expect(monday.find((s) => local(s.start).endsWith("09:30"))!.freeHostIds).toEqual(["b"]);
    expect(monday.find((s) => local(s.start).endsWith("13:00"))!.freeHostIds).toEqual(["a"]);
    const tuesday = slots.find((s) => local(s.start).startsWith("2026-10-06"))!;
    expect(tuesday.freeHostIds).toEqual(["a", "b"]);
    expect(slots.some((s) => s.freeHostIds.includes("c"))).toBe(false);
  });

  it("round-robin with every host busy yields nothing", () => {
    const allBusy = [{ start: t("2026-10-05T00:00"), end: t("2026-10-06T00:00"), showAs: "busy", isAllDay: false }];
    const slots = run({ mode: "round_robin", hosts: [host("a", { busy: allBusy }), host("b", { busy: allBusy })] });
    expect(onDate(slots, "2026-10-05")).toEqual([]);
  });

  it("collective intersects all required hosts", () => {
    const partial = [{ start: t("2026-10-05T11:00"), end: t("2026-10-05T12:00"), showAs: "busy", isAllDay: false }];
    const slots = run({
      mode: "collective",
      hosts: [
        host("a", { busy: busyMorning }),
        host("b", { busy: partial }),
        host("opt", { isRequired: false, busy: busyAfternoon }),
      ],
    });
    const monday = slots.filter((s) => local(s.start).startsWith("2026-10-05"));
    expect(monday.map((s) => local(s.start).slice(11))[0]).toBe("12:00");
    expect(monday).toHaveLength(13);
    expect(monday.every((s) => s.freeHostIds.join() === "a,b")).toBe(true);
  });

  it("collective intersects host schedules in different zones", () => {
    const la = weekdays(LA);
    const slots = run({
      mode: "collective",
      hosts: [host("ny"), host("la", { timezone: LA, schedule: la })],
    });
    // Event 9:30-18:30 NY, LA host 9:30-18:30 LA = 12:30-21:30 NY.
    expect(onDate(slots, "2026-10-05")[0]).toBe("12:30");
    expect(onDate(slots, "2026-10-05")).toHaveLength(12);
  });

  it("collective with an ineligible required host yields nothing", () => {
    expect(run({ mode: "collective", hosts: [host("a"), host("b", { eligible: false })] })).toEqual([]);
  });

  it("collective ignores ineligible optional hosts", () => {
    const slots = run({ mode: "collective", hosts: [host("a"), host("b", { isRequired: false, eligible: false })] });
    expect(onDate(slots, "2026-10-05")).toHaveLength(18);
  });
});
