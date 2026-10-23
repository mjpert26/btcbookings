import { describe, expect, it } from "vitest";
import { actionLabel, actorLabel, fieldChanges, fieldLabel, formatAuditValue, viaLabel } from "@/lib/audit-diff";
import { changedFields, maskPhone, redactSecrets } from "@/server/audit";

describe("fieldChanges", () => {
  it("lists only differing fields, with nested paths", () => {
    expect(
      fieldChanges(
        { name: "Intro", questions: { company: { required: false, label: { en: "Company" } } }, durations: [15, 30] },
        { name: "Intro", questions: { company: { required: true, label: { en: "Company" } } }, durations: [30] },
      ),
    ).toEqual([
      { field: "questions.company.required", path: ["questions", "company", "required"], before: false, after: true },
      { field: "durations", path: ["durations"], before: [15, 30], after: [30] },
    ]);
  });

  it("lists every field of a create or a delete", () => {
    expect(fieldChanges(null, { status: "confirmed", hosts: ["Ana"] }).map((c) => [c.field, c.before, c.after])).toEqual([
      ["status", undefined, "confirmed"],
      ["hosts", undefined, ["Ana"]],
    ]);
    expect(fieldChanges({ pattern: "https://x" }, null)).toEqual([{ field: "pattern", path: ["pattern"], before: "https://x", after: undefined }]);
    expect(fieldChanges(null, null)).toEqual([]);
  });

  it("keeps keys that are not identifiers intact", () => {
    const [c] = fieldChanges({ hosts: { "ana@bigthinkcapital.com": { required: true } } }, { hosts: { "ana@bigthinkcapital.com": { required: false } } });
    expect(c.path).toEqual(["hosts", "ana@bigthinkcapital.com", "required"]);
    expect(fieldLabel(c.path)).toBe("Hosts › ana@bigthinkcapital.com › Required");
  });
});

describe("labels and values", () => {
  it("formats field names", () => {
    expect(fieldLabel("agent_reminder_offsets_min")).toBe("Agent reminder offsets (min)");
    expect(fieldLabel("min_notice_min")).toBe("Min notice (min)");
    expect(fieldLabel("dailyBookingCap")).toBe("Daily booking cap");
    expect(fieldLabel("sms_phone")).toBe("SMS phone");
    expect(fieldLabel(["2026-11-27"])).toBe("2026-11-27");
  });

  it("formats values", () => {
    expect(formatAuditValue(true)).toBe("Yes");
    expect(formatAuditValue(null)).toBe("(empty)");
    expect(formatAuditValue(undefined)).toBe("—");
    expect(formatAuditValue([])).toBe("(none)");
    expect(formatAuditValue(["busy", "oof"])).toBe("busy, oof");
    expect(formatAuditValue({ a: 1 })).toBe('{"a":1}');
    expect(formatAuditValue("2026-10-23T15:00:00.000Z", "America/New_York")).toBe("23 Oct 2026, 11:00 AM EDT");
  });

  it("names actions, actors and channels", () => {
    expect(actionLabel("booking.reassign")).toBe("Host reassigned");
    expect(actionLabel("team.create")).toBe("team.create");
    expect(actorLabel(null, "public")).toBe("Invitee");
    expect(actorLabel(null, "system")).toBe("System");
    expect(actorLabel("Ana", "web")).toBe("Ana");
    expect(viaLabel("mcp")).toBe("MCP");
    expect(viaLabel(null)).toBe("Unknown");
  });
});

describe("audit write helpers", () => {
  it("changedFields keeps only changed keys", () => {
    expect(changedFields({ a: 1, b: [1, 2], c: null }, { a: 1, b: [2], c: undefined })).toEqual({ before: { b: [1, 2] }, after: { b: [2] } });
    expect(changedFields({ a: 1 }, { a: 1 })).toBeNull();
  });

  it("masks phone numbers to the last four digits", () => {
    expect(maskPhone("+13128644567")).toBe("***-4567");
    expect(maskPhone("123")).toBe("***");
    expect(maskPhone(null)).toBeNull();
  });

  it("redacts secret-looking keys at any depth", () => {
    expect(
      redactSecrets({ name: "Hook", secret: "s3cr3t", nested: { access_token: "a", refreshToken: "r", manage_token_enc: "x", tokens: 3 }, list: [{ client_secret: "c" }] }),
    ).toEqual({ name: "Hook", secret: "[redacted]", nested: { access_token: "[redacted]", refreshToken: "[redacted]", manage_token_enc: "[redacted]", tokens: 3 }, list: [{ client_secret: "[redacted]" }] });
  });
});
