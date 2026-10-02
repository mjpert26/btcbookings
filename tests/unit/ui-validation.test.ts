import { describe, expect, it } from "vitest";
import { intervalListError, intervalListSchema, normalizeWeekly, weeklyRulesSchema, isValidTimeZone } from "@/lib/availability";
import { questionsSchema } from "@/lib/event-types";
import { SF_ACCOUNT_ID_RE, SF_QUEUE_ID_RE, SLACK_CHANNEL_RE } from "@/lib/ids";

describe("availability intervals", () => {
  it("accepts ordered, touching intervals", () => {
    expect(intervalListError([{ start: "09:00", end: "12:00" }, { start: "12:00", end: "17:00" }])).toBeNull();
  });

  it("rejects start after end and overlaps", () => {
    expect(intervalListError([{ start: "10:00", end: "09:00" }])).toMatch(/before end/);
    expect(intervalListError([{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }])).toMatch(/overlap/);
  });

  it("sorts intervals and rejects bad times", () => {
    const parsed = intervalListSchema.parse([{ start: "13:00", end: "14:00" }, { start: "08:00", end: "09:00" }]);
    expect(parsed[0].start).toBe("08:00");
    expect(intervalListSchema.safeParse([{ start: "9:00", end: "10:00" }]).success).toBe(false);
  });

  it("requires every weekday and normalizes stored rules", () => {
    expect(weeklyRulesSchema.safeParse({ mon: [] }).success).toBe(false);
    const w = normalizeWeekly({ mon: [{ start: "09:00", end: "10:00" }] });
    expect(w.mon).toHaveLength(1);
    expect(w.sun).toEqual([]);
  });

  it("validates IANA time zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});

describe("event type questions", () => {
  it("requires options for dropdowns and unique keys", () => {
    const dropdown = { key: "rev", type: "dropdown", label: { en: "Revenue" }, options: [] };
    expect(questionsSchema.safeParse([dropdown]).success).toBe(false);
    const q = { key: "company", type: "text", label: { en: "Company" } };
    const dup = questionsSchema.safeParse([q, q]);
    expect(dup.success).toBe(false);
    expect(questionsSchema.safeParse([q]).success).toBe(true);
  });

  it("rejects keys that cannot be used in Salesforce mappings", () => {
    expect(questionsSchema.safeParse([{ key: "Company Name", type: "text", label: { en: "x" } }]).success).toBe(false);
  });
});

describe("external id formats", () => {
  it("matches Salesforce and Slack ids", () => {
    expect(SF_QUEUE_ID_RE.test("00G5e000001AbCdEAF")).toBe(true);
    expect(SF_QUEUE_ID_RE.test("00G5e000001AbCd")).toBe(true);
    expect(SF_QUEUE_ID_RE.test("0055e000001AbCdEAF")).toBe(false);
    expect(SF_ACCOUNT_ID_RE.test("0015e00000AbCdEAAV")).toBe(true);
    expect(SLACK_CHANNEL_RE.test("C0123ABCD")).toBe(true);
    expect(SLACK_CHANNEL_RE.test("#general")).toBe(false);
  });
});
