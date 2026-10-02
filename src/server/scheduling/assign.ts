/**
 * Round-robin host assignment (PLAN 4.2). Pure and deterministic: the same input always
 * picks the same host, which keeps the booking transaction and tests reproducible.
 *
 * - fairness: oldest rrLastAssignedAt (never assigned first), then lowest
 *   rrAssignmentCount, then lowest userId.
 * - weighted: lowest (rrAssignmentCount + 1) / weight (smooth weighted round-robin), then
 *   the fairness order. Hosts with weight <= 0 are never assigned by this strategy.
 * - priority: restrict to the lowest priorityTier present among candidates, then fairness.
 * - preferredUserId (sticky returning invitee or original host on reschedule) wins when
 *   that host is an eligible candidate, regardless of priority tier. A weight-0 host is
 *   never picked by the weighted strategy, even when preferred.
 */
import type { AssignmentInput, HostAvailabilityInput, RrStrategy } from "./types";

function compareFairness(a: HostAvailabilityInput, b: HostAvailabilityInput): number {
  const at = a.rrLastAssignedAt;
  const bt = b.rrLastAssignedAt;
  if (at !== bt) {
    if (at === null) return -1;
    if (bt === null) return 1;
    return at - bt;
  }
  if (a.rrAssignmentCount !== b.rrAssignmentCount) {
    return a.rrAssignmentCount - b.rrAssignmentCount;
  }
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

function compareWeighted(a: HostAvailabilityInput, b: HostAvailabilityInput): number {
  // Compare (a.count + 1) / a.weight with (b.count + 1) / b.weight without division.
  const lhs = (a.rrAssignmentCount + 1) * b.weight;
  const rhs = (b.rrAssignmentCount + 1) * a.weight;
  if (lhs !== rhs) return lhs - rhs;
  return compareFairness(a, b);
}

/** Candidates the strategy may ever pick: eligible, and weight > 0 for weighted. */
function assignable(strategy: RrStrategy, candidates: HostAvailabilityInput[]) {
  return candidates.filter((c) => c.eligible && (strategy !== "weighted" || c.weight > 0));
}

export function assignHost(input: AssignmentInput): HostAvailabilityInput | null {
  let candidates = assignable(input.strategy, input.candidates);
  if (candidates.length === 0) return null;
  if (input.preferredUserId) {
    const preferred = candidates.find((c) => c.userId === input.preferredUserId);
    if (preferred) return preferred;
  }
  if (input.strategy === "priority") {
    const tier = Math.min(...candidates.map((c) => c.priorityTier));
    candidates = candidates.filter((c) => c.priorityTier === tier);
  }
  const compare = input.strategy === "weighted" ? compareWeighted : compareFairness;
  return candidates.reduce((best, c) => (compare(c, best) < 0 ? c : best));
}

export type SimulationOptions = {
  /** Number of bookings to assign. */
  bookings: number;
  /** Epoch ms of the first assignment; each later one is one minute after the previous. */
  startAt?: number;
  /** Returns the userIds free for booking i; defaults to every host. */
  available?: (index: number) => string[] | null;
};

/**
 * Runs assignHost repeatedly, updating rrAssignmentCount and rrLastAssignedAt the way the
 * booking transaction does. Returns assignment counts per userId (unassigned bookings are
 * counted under the empty string). Input hosts are not mutated.
 */
export function simulateAssignments(
  strategy: RrStrategy,
  hosts: HostAvailabilityInput[],
  options: SimulationOptions,
): Record<string, number> {
  const state = hosts.map((h) => ({ ...h }));
  const counts: Record<string, number> = Object.fromEntries(hosts.map((h) => [h.userId, 0]));
  let t = options.startAt ?? 0;
  for (let i = 0; i < options.bookings; i++) {
    const free = options.available?.(i);
    const candidates = free ? state.filter((h) => free.includes(h.userId)) : state;
    const picked = assignHost({ strategy, candidates });
    if (!picked) {
      counts[""] = (counts[""] ?? 0) + 1;
      continue;
    }
    picked.rrAssignmentCount += 1;
    picked.rrLastAssignedAt = t;
    counts[picked.userId] += 1;
    t += 60_000;
  }
  return counts;
}
