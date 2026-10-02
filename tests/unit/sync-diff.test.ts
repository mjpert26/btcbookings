import { describe, expect, it } from "vitest";
import {
  diffPushChange,
  diffTeamSnapshot,
  exceedsThreshold,
  normalizeQueueId,
  toSalesforceId18,
  type AppUserInfo,
  type CurrentMember,
  type DiffInput,
  type QueueSnapshot,
  type SnapshotMember,
} from "@/server/sync/diff";

const Q1 = "00GVy00000TRvHdMAL";
const Q2 = "00GVy00000SRIlVMAX";

let seq = 0;
const sf = (email: string, isActive = true): SnapshotMember => ({
  sfUserId: `005Vy0000000${String(++seq).padStart(3, "0")}AAA`,
  email,
  isActive,
});
const member = (email: string, over: Partial<CurrentMember> = {}): CurrentMember => ({
  id: `tm-${email}`,
  email,
  sfUserId: null,
  userId: `u-${email}`,
  status: "active",
  source: "queue",
  pausedReason: null,
  ...over,
});
const healthy = (...emails: string[]) =>
  new Map<string, AppUserInfo>(emails.map((e) => [e.toLowerCase(), { userId: `u-${e.toLowerCase()}`, calendarHealthy: true }]));

function input(over: Partial<DiffInput> & { queues?: QueueSnapshot[] } = {}): DiffInput {
  const queues = over.queues ?? [{ queueId: Q1, members: [] }];
  return {
    team: { id: "t1", membershipSource: "salesforce_queue", massRemovalThresholdPct: 50 },
    linkedQueues: queues.map((q) => ({ queueId: q.queueId, lastMemberCount: null })),
    snapshots: new Map(queues.map((q) => [q.queueId, q])),
    current: [],
    appUsers: new Map(),
    ...over,
  };
}

function ok(result: ReturnType<typeof diffTeamSnapshot>) {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result;
}

describe("diffTeamSnapshot", () => {
  it("adds new queue members as active when onboarded, pending otherwise", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("a@x.com"), sf("b@x.com")] }],
          appUsers: new Map([
            ["a@x.com", { userId: "ua", calendarHealthy: true }],
            ["b@x.com", { userId: "ub", calendarHealthy: false }],
          ]),
        }),
      ),
    );
    expect(r.changes).toHaveLength(2);
    expect(r.changes.find((c) => c.email === "a@x.com")).toMatchObject({ kind: "add", newStatus: "active", userId: "ua" });
    expect(r.changes.find((c) => c.email === "b@x.com")).toMatchObject({ kind: "add", newStatus: "pending_onboarding", userId: "ub" });
  });

  it("adds members with no app user as pending_onboarding", () => {
    const r = ok(diffTeamSnapshot(input({ queues: [{ queueId: Q1, members: [sf("new@x.com")] }] })));
    expect(r.changes[0]).toMatchObject({ kind: "add", newStatus: "pending_onboarding", userId: null, oldStatus: null });
  });

  it("pauses queue members who left every queue (never deletes)", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("a@x.com"), sf("b@x.com")] }],
          current: [member("a@x.com"), member("b@x.com"), member("c@x.com")],
          appUsers: healthy("a@x.com", "b@x.com"),
        }),
      ),
    );
    expect(r.changes).toEqual([
      expect.objectContaining({ kind: "remove", email: "c@x.com", teamMemberId: "tm-c@x.com", oldStatus: "active", newStatus: "paused" }),
    ]);
  });

  it("treats inactive Salesforce users as removed", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("a@x.com"), sf("b@x.com"), sf("c@x.com", false)] }],
          current: [member("a@x.com"), member("b@x.com"), member("c@x.com")],
          appUsers: healthy("a@x.com", "b@x.com", "c@x.com"),
        }),
      ),
    );
    expect(r.changes.map((c) => [c.kind, c.email])).toEqual([["remove", "c@x.com"]]);
    expect(r.counts.desired).toBe(2);
  });

  it("does not add an inactive Salesforce user", () => {
    const r = ok(diffTeamSnapshot(input({ queues: [{ queueId: Q1, members: [sf("a@x.com", false)] }] })));
    expect(r.changes).toEqual([]);
  });

  it("reinstates sync-paused members without touching anything but status", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("a@x.com"), sf("b@x.com")] }],
          current: [member("a@x.com"), member("b@x.com", { status: "paused", pausedReason: "removed_from_queue" })],
          appUsers: healthy("a@x.com", "b@x.com"),
        }),
      ),
    );
    expect(r.changes).toEqual([
      expect.objectContaining({ kind: "reinstate", teamMemberId: "tm-b@x.com", oldStatus: "paused", newStatus: "active" }),
    ]);
  });

  it("reinstates to pending_onboarding when the calendar is not healthy", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("b@x.com")] }],
          current: [member("b@x.com", { status: "paused", pausedReason: null })],
          appUsers: new Map([["b@x.com", { userId: "ub", calendarHealthy: false }]]),
        }),
      ),
    );
    expect(r.changes[0]).toMatchObject({ kind: "reinstate", newStatus: "pending_onboarding" });
  });

  it("never reinstates a member an admin paused", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("b@x.com")] }],
          current: [member("b@x.com", { status: "paused", pausedReason: "admin_override" })],
          appUsers: healthy("b@x.com"),
        }),
      ),
    );
    expect(r.changes).toEqual([]);
  });

  it("promotes pending members once they are onboarded", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("b@x.com")] }],
          current: [member("b@x.com", { status: "pending_onboarding", userId: null })],
          appUsers: healthy("b@x.com"),
        }),
      ),
    );
    expect(r.changes[0]).toMatchObject({ kind: "promote", oldStatus: "pending_onboarding", newStatus: "active", userId: "u-b@x.com" });
  });

  it("leaves manual members untouched, including when they are also in the queue", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          team: { id: "t1", membershipSource: "queue_plus_manual", massRemovalThresholdPct: 50 },
          queues: [{ queueId: Q1, members: [sf("both@x.com"), sf("q@x.com")] }],
          current: [
            member("both@x.com", { source: "manual" }),
            member("manual-only@x.com", { source: "manual" }),
            member("manual-paused@x.com", { source: "manual", status: "paused" }),
            member("q@x.com"),
          ],
          appUsers: healthy("both@x.com", "q@x.com"),
        }),
      ),
    );
    expect(r.changes).toEqual([]);
    expect(r.counts.manualOverlap).toBe(1);
  });

  it("unions members across all linked queues", () => {
    const shared = sf("shared@x.com");
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [
            { queueId: Q1, members: [sf("a@x.com"), shared] },
            { queueId: Q2, members: [{ ...shared }, sf("b@x.com")] },
          ],
          current: [member("shared@x.com"), member("a@x.com")],
          appUsers: healthy("a@x.com", "b@x.com", "shared@x.com"),
        }),
      ),
    );
    expect(r.changes.map((c) => [c.kind, c.email])).toEqual([["add", "b@x.com"]]);
    expect(r.counts.desired).toBe(3);
    expect(r.queueMemberCounts).toEqual({ [Q1]: 2, [Q2]: 2 });
  });

  it("matches emails case-insensitively", () => {
    const r = ok(
      diffTeamSnapshot(
        input({
          queues: [{ queueId: Q1, members: [sf("Mixed.Case@X.com"), sf("  other@x.com ")] }],
          current: [member("mixed.case@x.com"), member("OTHER@X.COM")],
          appUsers: healthy("mixed.case@x.com", "other@x.com"),
        }),
      ),
    );
    expect(r.changes).toEqual([]);
  });

  it("skips manual teams and incomplete snapshots", () => {
    expect(
      diffTeamSnapshot(input({ team: { id: "t1", membershipSource: "manual", massRemovalThresholdPct: 50 } })),
    ).toMatchObject({ status: "skipped", reason: "manual_team" });
    const partial = input({ queues: [{ queueId: Q1, members: [] }] });
    partial.linkedQueues.push({ queueId: Q2, lastMemberCount: 3 });
    expect(diffTeamSnapshot(partial)).toMatchObject({ status: "skipped", reason: "incomplete_snapshot", missingQueueIds: [Q2] });
    expect(diffTeamSnapshot({ ...input(), linkedQueues: [] })).toMatchObject({ status: "skipped", reason: "no_linked_queues" });
  });

  describe("safety rail", () => {
    const team = (pct: number) => ({ id: "t1", membershipSource: "salesforce_queue" as const, massRemovalThresholdPct: pct });
    const four = ["a", "b", "c", "d"].map((x) => `${x}@x.com`);

    it("allows removals exactly at the threshold", () => {
      // 2 of 4 removed = 50%: allowed.
      const r = diffTeamSnapshot(
        input({ team: team(50), queues: [{ queueId: Q1, members: [sf(four[0]), sf(four[1])] }], current: four.map((e) => member(e)), appUsers: healthy(...four) }),
      );
      expect(r.status).toBe("ok");
    });

    it("blocks removals above the threshold and reports counts", () => {
      // 3 of 4 removed = 75%: blocked.
      const r = diffTeamSnapshot(
        input({ team: team(50), queues: [{ queueId: Q1, members: [sf(four[0])] }], current: four.map((e) => member(e)), appUsers: healthy(...four) }),
      );
      expect(r).toMatchObject({ status: "blocked", reason: "threshold", thresholdPct: 50, counts: { removals: 3, currentActiveQueueMembers: 4 } });
    });

    it("counts only non-paused queue members in the denominator", () => {
      const current = [
        ...four.map((e) => member(e)),
        member("p1@x.com", { status: "paused", pausedReason: "removed_from_queue" }),
        member("m1@x.com", { source: "manual" }),
      ];
      const r = diffTeamSnapshot(
        input({ team: team(50), queues: [{ queueId: Q1, members: [sf(four[0])] }], current, appUsers: healthy(...four) }),
      );
      expect(r).toMatchObject({ status: "blocked", counts: { currentActiveQueueMembers: 4, removals: 3 } });
    });

    it("blocks an empty snapshot for a queue that previously had members", () => {
      const r = diffTeamSnapshot({
        ...input({ team: team(100), queues: [{ queueId: Q1, members: [] }], current: [member("a@x.com")] }),
        linkedQueues: [{ queueId: Q1, lastMemberCount: 1 }],
      });
      expect(r).toMatchObject({ status: "blocked", reason: "empty_queue", emptiedQueueIds: [Q1] });
    });

    it("blocks an emptied queue even when the overall percentage is under the threshold", () => {
      const big = Array.from({ length: 10 }, (_, i) => `big${i}@x.com`);
      const r = diffTeamSnapshot({
        ...input({
          team: team(50),
          queues: [
            { queueId: Q1, members: [] },
            { queueId: Q2, members: big.map((e) => sf(e)) },
          ],
          current: [...big.map((e) => member(e)), member("small@x.com")],
          appUsers: healthy(...big),
        }),
        linkedQueues: [
          { queueId: Q1, lastMemberCount: 1 },
          { queueId: Q2, lastMemberCount: 10 },
        ],
      });
      expect(r).toMatchObject({ status: "blocked", reason: "empty_queue" });
    });

    it("blocks a first empty snapshot through the threshold rule", () => {
      const r = diffTeamSnapshot(input({ team: team(50), queues: [{ queueId: Q1, members: [] }], current: [member("a@x.com"), member("b@x.com")] }));
      expect(r).toMatchObject({ status: "blocked", reason: "threshold" });
    });

    it("allows an empty queue with no prior members and no removals", () => {
      const r = diffTeamSnapshot(input({ queues: [{ queueId: Q1, members: [] }] }));
      expect(r).toMatchObject({ status: "ok", changes: [] });
    });

    it("applies a blocked change once an admin approved it", () => {
      const r = diffTeamSnapshot(
        input({
          team: { ...team(50), massRemovalApproved: true },
          queues: [{ queueId: Q1, members: [] }],
          current: four.map((e) => member(e)),
        }),
      );
      expect(ok(r).counts.removals).toBe(4);
    });

    it("exceedsThreshold boundaries", () => {
      expect(exceedsThreshold(5, 10, 50)).toBe(false);
      expect(exceedsThreshold(6, 10, 50)).toBe(true);
      expect(exceedsThreshold(1, 0, 50)).toBe(false);
      expect(exceedsThreshold(0, 10, 1)).toBe(false);
      expect(exceedsThreshold(10, 10, 100)).toBe(false);
    });
  });
});

describe("diffPushChange", () => {
  const base = { sfUserId: "005Vy00000AAAAAAAA", appUser: { userId: "u1", calendarHealthy: true }, stillInOtherLinkedQueue: false };
  it("adds, reinstates, and ignores manual members", () => {
    expect(diffPushChange({ ...base, action: "added", email: "A@x.com", existing: undefined })).toMatchObject({ kind: "add", email: "a@x.com", newStatus: "active" });
    expect(
      diffPushChange({ ...base, action: "added", email: "a@x.com", existing: member("a@x.com", { status: "paused", pausedReason: "removed_from_queue" }) }),
    ).toMatchObject({ kind: "reinstate" });
    expect(diffPushChange({ ...base, action: "added", email: "a@x.com", existing: member("a@x.com", { source: "manual", status: "paused" }) })).toBeNull();
    expect(diffPushChange({ ...base, action: "added", email: "a@x.com", existing: member("a@x.com") })).toBeNull();
  });
  it("removes unless still in another linked queue", () => {
    expect(diffPushChange({ ...base, action: "removed", email: "a@x.com", existing: member("a@x.com") })).toMatchObject({ kind: "remove", newStatus: "paused" });
    expect(diffPushChange({ ...base, action: "removed", email: "a@x.com", existing: member("a@x.com"), stillInOtherLinkedQueue: true })).toBeNull();
    expect(diffPushChange({ ...base, action: "removed", email: "a@x.com", existing: undefined })).toBeNull();
  });
});

describe("queue ids", () => {
  it("converts 15-character ids to 18 characters", () => {
    expect(toSalesforceId18("00GVy00000TRvHd")).toBe("00GVy00000TRvHdMAL");
    expect(toSalesforceId18("00GVy00000SRIlV")).toBe("00GVy00000SRIlVMAX");
    expect(normalizeQueueId("00GVy00000WQWhl")).toBe("00GVy00000WQWhlMAH");
  });
  it("validates format and checksum", () => {
    expect(normalizeQueueId(" 00GVy00000WQWhlMAH ")).toBe("00GVy00000WQWhlMAH");
    expect(normalizeQueueId("00GVy00000WQWhlmah")).toBe("00GVy00000WQWhlMAH");
    expect(normalizeQueueId("00GVy00000WQWhlXXX")).toBeNull();
    expect(normalizeQueueId("005Vy00000WQWhlMAH")).toBeNull();
    expect(normalizeQueueId("00G123")).toBeNull();
  });
});
