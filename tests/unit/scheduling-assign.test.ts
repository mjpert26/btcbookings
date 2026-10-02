import { describe, expect, it } from "vitest";
import { assignHost, simulateAssignments } from "@/server/scheduling";
import type { HostAvailabilityInput } from "@/server/scheduling";
import { host } from "./scheduling-fixtures";

/** Deterministic PRNG (mulberry32) so simulations are reproducible. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (hosts: HostAvailabilityInput[] | null) => hosts?.map((h) => h.userId);

describe("fairness", () => {
  it("prefers never-assigned hosts, then the oldest assignment", () => {
    const a = host("a", { rrLastAssignedAt: 2000, rrAssignmentCount: 1 });
    const b = host("b", { rrLastAssignedAt: 1000, rrAssignmentCount: 5 });
    const c = host("c", { rrLastAssignedAt: null, rrAssignmentCount: 9 });
    expect(assignHost({ strategy: "fairness", candidates: [a, b, c] })?.userId).toBe("c");
    expect(assignHost({ strategy: "fairness", candidates: [a, b] })?.userId).toBe("b");
  });

  it("breaks ties by lowest count, then userId", () => {
    const a = host("a", { rrLastAssignedAt: 1000, rrAssignmentCount: 3 });
    const b = host("b", { rrLastAssignedAt: 1000, rrAssignmentCount: 2 });
    const c = host("c", { rrLastAssignedAt: 1000, rrAssignmentCount: 2 });
    expect(assignHost({ strategy: "fairness", candidates: [c, a, b] })?.userId).toBe("b");
    expect(assignHost({ strategy: "fairness", candidates: [host("z"), host("m")] })?.userId).toBe("m");
  });

  it("is independent of candidate order", () => {
    const hosts = [host("a", { rrLastAssignedAt: 5 }), host("b", { rrLastAssignedAt: 5 }), host("c", { rrLastAssignedAt: 5 })];
    const reversed = [...hosts].reverse();
    expect(assignHost({ strategy: "fairness", candidates: hosts })).toBe(
      assignHost({ strategy: "fairness", candidates: reversed }),
    );
  });

  it("returns null with no candidates and ignores ineligible ones", () => {
    expect(assignHost({ strategy: "fairness", candidates: [] })).toBeNull();
    expect(assignHost({ strategy: "fairness", candidates: [host("a", { eligible: false })] })).toBeNull();
    expect(
      assignHost({ strategy: "fairness", candidates: [host("a", { eligible: false }), host("b", { rrLastAssignedAt: 9 })] })
        ?.userId,
    ).toBe("b");
  });

  it("keeps the assignment spread at most 1 over 10,000 bookings", () => {
    const state = ["a", "b", "c", "d", "e", "f", "g"].map((id) => host(id));
    let maxSpread = 0;
    for (let i = 0; i < 10_000; i++) {
      const picked = assignHost({ strategy: "fairness", candidates: state })!;
      picked.rrAssignmentCount += 1;
      picked.rrLastAssignedAt = i * 60_000;
      const counts = state.map((h) => h.rrAssignmentCount);
      maxSpread = Math.max(maxSpread, Math.max(...counts) - Math.min(...counts));
    }
    expect(maxSpread).toBeLessThanOrEqual(1);
    expect(state.reduce((n, h) => n + h.rrAssignmentCount, 0)).toBe(10_000);
  });

  it("starts fair from uneven history", () => {
    const hosts = [
      host("a", { rrAssignmentCount: 50, rrLastAssignedAt: 100 }),
      host("b", { rrAssignmentCount: 10, rrLastAssignedAt: 200 }),
      host("new"),
    ];
    const counts = simulateAssignments("fairness", hosts, { bookings: 9_999, startAt: 1_000 });
    expect(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts))).toBeLessThanOrEqual(1);
    expect(hosts[2].rrAssignmentCount).toBe(0); // inputs are not mutated
  });

  it("only assigns free hosts under random availability", () => {
    const hosts = ["a", "b", "c", "d"].map((id) => host(id));
    const random = rng(42);
    const freeSets: string[][] = [];
    const counts = simulateAssignments("fairness", hosts, {
      bookings: 10_000,
      available: (i) => {
        const free = hosts.map((h) => h.userId).filter(() => random() < 0.6);
        freeSets[i] = free;
        return free;
      },
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(10_000);
    const unassigned = freeSets.filter((s) => s.length === 0).length;
    expect(counts[""] ?? 0).toBe(unassigned);
    // Equal availability odds produce near-equal shares.
    for (const id of ["a", "b", "c", "d"]) {
      expect(Math.abs(counts[id] / (10_000 - unassigned) - 0.25)).toBeLessThan(0.02);
    }
  });
});

describe("weighted", () => {
  it("picks the lowest (count + 1) / weight", () => {
    const a = host("a", { weight: 1, rrAssignmentCount: 1 }); // 2
    const b = host("b", { weight: 3, rrAssignmentCount: 4 }); // 1.67
    const c = host("c", { weight: 2, rrAssignmentCount: 3 }); // 2
    expect(assignHost({ strategy: "weighted", candidates: [a, b, c] })?.userId).toBe("b");
  });

  it("never assigns weight 0, even when it is the only candidate or preferred", () => {
    const zero = host("zero", { weight: 0 });
    expect(assignHost({ strategy: "weighted", candidates: [zero] })).toBeNull();
    expect(
      assignHost({ strategy: "weighted", candidates: [zero, host("b")], preferredUserId: "zero" })?.userId,
    ).toBe("b");
  });

  it("matches weights within 1% over 10,000 bookings", () => {
    const weights: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, zero: 0 };
    const hosts = Object.entries(weights).map(([id, weight]) => host(id, { weight }));
    const counts = simulateAssignments("weighted", hosts, { bookings: 10_000 });
    const totalWeight = 10;
    for (const [id, w] of Object.entries(weights)) {
      expect(Math.abs(counts[id] / 10_000 - w / totalWeight)).toBeLessThanOrEqual(0.01);
    }
    expect(counts.zero).toBe(0);
    expect(counts).toMatchObject({ a: 1000, b: 2000, c: 3000, d: 4000 });
  });

  it("is deterministic", () => {
    const hosts = [host("a", { weight: 5 }), host("b", { weight: 7 }), host("c", { weight: 1 })];
    expect(simulateAssignments("weighted", hosts, { bookings: 1234 })).toEqual(
      simulateAssignments("weighted", hosts, { bookings: 1234 }),
    );
  });

  it("gives the uneven weights 5:7:1 proportional shares", () => {
    const hosts = [host("a", { weight: 5 }), host("b", { weight: 7 }), host("c", { weight: 1 })];
    const counts = simulateAssignments("weighted", hosts, { bookings: 10_000 });
    expect(Math.abs(counts.a / 10_000 - 5 / 13)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(counts.b / 10_000 - 7 / 13)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(counts.c / 10_000 - 1 / 13)).toBeLessThanOrEqual(0.01);
  });
});

describe("priority", () => {
  it("uses the lowest tier with a candidate, then fairness within it", () => {
    const a = host("a", { priorityTier: 1, rrLastAssignedAt: 500 });
    const b = host("b", { priorityTier: 1, rrLastAssignedAt: 100 });
    const c = host("c", { priorityTier: 2 });
    expect(assignHost({ strategy: "priority", candidates: [a, b, c] })?.userId).toBe("b");
    expect(assignHost({ strategy: "priority", candidates: [c, a] })?.userId).toBe("a");
  });

  it("falls back to the next tier when the top tier has no free host", () => {
    const c = host("c", { priorityTier: 2, rrLastAssignedAt: 900 });
    const d = host("d", { priorityTier: 3 });
    expect(assignHost({ strategy: "priority", candidates: [c, d] })?.userId).toBe("c");
    expect(
      assignHost({ strategy: "priority", candidates: [host("a", { priorityTier: 1, eligible: false }), c] })?.userId,
    ).toBe("c");
  });

  it("routes overflow to lower tiers only when needed over 10,000 bookings", () => {
    const hosts = [host("a", { priorityTier: 1 }), host("b", { priorityTier: 1 }), host("c", { priorityTier: 2 })];
    const counts = simulateAssignments("priority", hosts, {
      bookings: 10_000,
      available: (i) => (i % 4 === 0 ? ["c"] : ["a", "b", "c"]),
    });
    expect(counts.c).toBe(2_500);
    expect(Math.abs(counts.a - counts.b)).toBeLessThanOrEqual(1);
    expect(counts.a + counts.b).toBe(7_500);
  });
});

describe("preferred host", () => {
  const hosts = [host("a"), host("b", { rrAssignmentCount: 99, rrLastAssignedAt: Date.UTC(2026, 9, 1) })];

  it("wins when present among candidates, for every strategy", () => {
    for (const strategy of ["fairness", "weighted", "priority"] as const) {
      expect(assignHost({ strategy, candidates: hosts, preferredUserId: "b" })?.userId).toBe("b");
    }
  });

  it("falls back to the strategy when absent or ineligible", () => {
    expect(assignHost({ strategy: "fairness", candidates: hosts, preferredUserId: "x" })?.userId).toBe("a");
    expect(
      assignHost({ strategy: "fairness", candidates: [host("a"), host("b", { eligible: false })], preferredUserId: "b" })
        ?.userId,
    ).toBe("a");
    expect(assignHost({ strategy: "fairness", candidates: hosts, preferredUserId: null })?.userId).toBe("a");
  });

  it("takes precedence over priority tiers", () => {
    const tiered = [host("a", { priorityTier: 1 }), host("b", { priorityTier: 2 })];
    expect(assignHost({ strategy: "priority", candidates: tiered, preferredUserId: "b" })?.userId).toBe("b");
  });

  it("is the result object from the input candidates", () => {
    const picked = assignHost({ strategy: "fairness", candidates: hosts });
    expect(ids(picked ? [picked] : null)).toEqual(["a"]);
    expect(hosts).toContain(picked);
  });
});
