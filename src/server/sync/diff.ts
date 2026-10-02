/**
 * Queue snapshot diffing (PLAN 4.5). Pure: no database or network access.
 *
 * The caller loads the team, its linked queues, its current members and the app users that
 * match the snapshot emails, then calls `diffTeamSnapshot`. `apply.ts` writes the result.
 */

export type MemberStatus = "active" | "paused" | "pending_onboarding";
export type MemberOrigin = "queue" | "manual";
export type MembershipSource = "manual" | "salesforce_queue" | "queue_plus_manual";

/** paused_reason written by sync. Members paused for any other reason are never reinstated by sync. */
export const QUEUE_REMOVAL_REASON = "removed_from_queue";
export const ADMIN_OVERRIDE_REASON = "admin_override";

export type SnapshotMember = { sfUserId: string; email: string; isActive: boolean };
export type QueueSnapshot = { queueId: string; members: SnapshotMember[] };

export type CurrentMember = {
  id: string;
  email: string;
  sfUserId: string | null;
  userId: string | null;
  status: MemberStatus;
  source: MemberOrigin;
  pausedReason: string | null;
};

/** App account for an email: the user id and whether the Outlook connection is healthy. */
export type AppUserInfo = { userId: string; calendarHealthy: boolean };

export type DiffTeam = {
  id: string;
  membershipSource: MembershipSource;
  massRemovalThresholdPct: number;
  /** True when an admin approved the next mass removal after a blocked sync. */
  massRemovalApproved?: boolean;
};

export type LinkedQueue = {
  queueId: string;
  /** Active member count from the last applied snapshot of this queue; null if never applied. */
  lastMemberCount: number | null;
};

export type DiffInput = {
  team: DiffTeam;
  linkedQueues: LinkedQueue[];
  /** Snapshots keyed by queue id. Must include every linked queue. */
  snapshots: Map<string, QueueSnapshot>;
  current: CurrentMember[];
  /** App users keyed by lower-case email. */
  appUsers: Map<string, AppUserInfo>;
};

export type ChangeKind = "add" | "remove" | "reinstate" | "promote";

export type MemberChange = {
  kind: ChangeKind;
  /** Lower-case email. */
  email: string;
  /** Existing row id; null for additions. */
  teamMemberId: string | null;
  sfUserId: string | null;
  userId: string | null;
  oldStatus: MemberStatus | null;
  newStatus: MemberStatus;
};

/** Metadata refresh on an existing queue member (user link or Salesforce user id). No status change. */
export type LinkUpdate = { teamMemberId: string; userId: string | null; sfUserId: string | null };

export type DiffCounts = {
  desired: number;
  currentActiveQueueMembers: number;
  additions: number;
  removals: number;
  reinstatements: number;
  promotions: number;
  manualOverlap: number;
};

export type DiffResult =
  | { status: "skipped"; reason: "manual_team" | "no_linked_queues" | "incomplete_snapshot"; missingQueueIds?: string[] }
  | {
      status: "blocked";
      reason: "threshold" | "empty_queue";
      counts: DiffCounts;
      thresholdPct: number;
      emptiedQueueIds: string[];
    }
  | {
      status: "ok";
      changes: MemberChange[];
      linkUpdates: LinkUpdate[];
      counts: DiffCounts;
      /** Active member count per queue in this snapshot, for team_sf_queues.last_member_count. */
      queueMemberCounts: Record<string, number>;
    };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Status for a queue member who should be in the pool: active only when onboarded. */
export function onboardedStatus(user: AppUserInfo | undefined): MemberStatus {
  return user && user.calendarHealthy ? "active" : "pending_onboarding";
}

/** Active members of one queue snapshot, keyed by lower-case email (first occurrence wins). */
export function activeMembersOf(snapshot: QueueSnapshot): Map<string, SnapshotMember> {
  const out = new Map<string, SnapshotMember>();
  for (const m of snapshot.members) {
    if (!m.isActive) continue;
    const email = normalizeEmail(m.email);
    if (!email || out.has(email)) continue;
    out.set(email, { ...m, email });
  }
  return out;
}

/**
 * Safety rail: true when removals exceed thresholdPct percent of the active queue members.
 * Exactly at the threshold is allowed. With no active queue members nothing can be blocked.
 */
export function exceedsThreshold(removals: number, activeQueueMembers: number, thresholdPct: number): boolean {
  if (activeQueueMembers <= 0 || removals <= 0) return false;
  return removals * 100 > thresholdPct * activeQueueMembers;
}

export function diffTeamSnapshot(input: DiffInput): DiffResult {
  const { team, linkedQueues, snapshots, current, appUsers } = input;
  if (team.membershipSource === "manual") return { status: "skipped", reason: "manual_team" };
  if (linkedQueues.length === 0) return { status: "skipped", reason: "no_linked_queues" };

  const missing = linkedQueues.filter((q) => !snapshots.has(q.queueId)).map((q) => q.queueId);
  if (missing.length > 0) return { status: "skipped", reason: "incomplete_snapshot", missingQueueIds: missing };

  // 1. Union of active members across every linked queue.
  const desired = new Map<string, SnapshotMember>();
  const queueMemberCounts: Record<string, number> = {};
  const emptiedQueueIds: string[] = [];
  for (const q of linkedQueues) {
    const active = activeMembersOf(snapshots.get(q.queueId)!);
    queueMemberCounts[q.queueId] = active.size;
    if (active.size === 0 && (q.lastMemberCount ?? 0) > 0) emptiedQueueIds.push(q.queueId);
    for (const [email, m] of active) if (!desired.has(email)) desired.set(email, m);
  }

  const byEmail = new Map<string, CurrentMember>();
  for (const m of current) byEmail.set(normalizeEmail(m.email), m);

  const changes: MemberChange[] = [];
  const linkUpdates: LinkUpdate[] = [];
  let manualOverlap = 0;

  // 2-3. Additions, reinstatements and promotions.
  for (const [email, sf] of desired) {
    const user = appUsers.get(email);
    const existing = byEmail.get(email);
    if (!existing) {
      changes.push({
        kind: "add",
        email,
        teamMemberId: null,
        sfUserId: sf.sfUserId,
        userId: user?.userId ?? null,
        oldStatus: null,
        newStatus: onboardedStatus(user),
      });
      continue;
    }
    if (existing.source === "manual") {
      // Manual members are owned by admins and never changed by sync.
      manualOverlap++;
      continue;
    }
    const userId = existing.userId ?? user?.userId ?? null;
    if (existing.status === "paused") {
      // Only reinstate members that sync itself paused (or legacy rows with no reason).
      if (existing.pausedReason === null || existing.pausedReason === QUEUE_REMOVAL_REASON) {
        changes.push({
          kind: "reinstate",
          email,
          teamMemberId: existing.id,
          sfUserId: sf.sfUserId,
          userId,
          oldStatus: "paused",
          newStatus: onboardedStatus(user),
        });
        continue;
      }
    } else if (existing.status === "pending_onboarding" && onboardedStatus(user) === "active") {
      changes.push({
        kind: "promote",
        email,
        teamMemberId: existing.id,
        sfUserId: sf.sfUserId,
        userId,
        oldStatus: "pending_onboarding",
        newStatus: "active",
      });
      continue;
    }
    if (userId !== existing.userId || sf.sfUserId !== existing.sfUserId) {
      linkUpdates.push({ teamMemberId: existing.id, userId, sfUserId: sf.sfUserId });
    }
  }

  // 3. Removals: queue members no longer in any linked queue are paused, never deleted.
  let currentActiveQueueMembers = 0;
  for (const m of current) {
    if (m.source !== "queue" || m.status === "paused") continue;
    currentActiveQueueMembers++;
    const email = normalizeEmail(m.email);
    if (desired.has(email)) continue;
    changes.push({
      kind: "remove",
      email,
      teamMemberId: m.id,
      sfUserId: m.sfUserId,
      userId: m.userId,
      oldStatus: m.status,
      newStatus: "paused",
    });
  }

  const count = (k: ChangeKind) => changes.filter((c) => c.kind === k).length;
  const counts: DiffCounts = {
    desired: desired.size,
    currentActiveQueueMembers,
    additions: count("add"),
    removals: count("remove"),
    reinstatements: count("reinstate"),
    promotions: count("promote"),
    manualOverlap,
  };

  // 4. Safety rail.
  if (!team.massRemovalApproved) {
    if (emptiedQueueIds.length > 0 && counts.removals > 0) {
      return { status: "blocked", reason: "empty_queue", counts, thresholdPct: team.massRemovalThresholdPct, emptiedQueueIds };
    }
    if (exceedsThreshold(counts.removals, currentActiveQueueMembers, team.massRemovalThresholdPct)) {
      return { status: "blocked", reason: "threshold", counts, thresholdPct: team.massRemovalThresholdPct, emptiedQueueIds };
    }
  }

  return { status: "ok", changes, linkUpdates, counts, queueMemberCounts };
}

export type PushChangeInput = {
  action: "added" | "removed";
  email: string;
  sfUserId: string | null;
  existing: CurrentMember | undefined;
  appUser: AppUserInfo | undefined;
  /** True when the person is in another queue linked to the same team (removals only). */
  stillInOtherLinkedQueue: boolean;
};

/**
 * Single-member change from a Salesforce push. The safety rail does not apply. Returns null
 * when nothing changes (manual member, already in the target state, admin-paused member, or a
 * removal of someone who is still in another linked queue).
 */
export function diffPushChange(input: PushChangeInput): MemberChange | null {
  const email = normalizeEmail(input.email);
  const { existing, appUser } = input;
  if (existing?.source === "manual") return null;
  if (input.action === "added") {
    if (!existing) {
      return {
        kind: "add",
        email,
        teamMemberId: null,
        sfUserId: input.sfUserId,
        userId: appUser?.userId ?? null,
        oldStatus: null,
        newStatus: onboardedStatus(appUser),
      };
    }
    const userId = existing.userId ?? appUser?.userId ?? null;
    const sfUserId = input.sfUserId ?? existing.sfUserId;
    if (existing.status === "paused" && (existing.pausedReason === null || existing.pausedReason === QUEUE_REMOVAL_REASON)) {
      return { kind: "reinstate", email, teamMemberId: existing.id, sfUserId, userId, oldStatus: "paused", newStatus: onboardedStatus(appUser) };
    }
    if (existing.status === "pending_onboarding" && onboardedStatus(appUser) === "active") {
      return { kind: "promote", email, teamMemberId: existing.id, sfUserId, userId, oldStatus: "pending_onboarding", newStatus: "active" };
    }
    return null;
  }
  if (!existing || existing.status === "paused" || input.stillInOtherLinkedQueue) return null;
  return {
    kind: "remove",
    email,
    teamMemberId: existing.id,
    sfUserId: existing.sfUserId,
    userId: existing.userId,
    oldStatus: existing.status,
    newStatus: "paused",
  };
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
export const QUEUE_ID_PATTERN = /^00G[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

/**
 * Converts a 15-character Salesforce id to its 18-character case-insensitive form.
 * 18-character ids are returned with the checksum suffix recomputed from the first 15.
 */
export function toSalesforceId18(id: string): string {
  if (id.length !== 15 && id.length !== 18) throw new Error("invalid Salesforce id length");
  const base = id.slice(0, 15);
  let suffix = "";
  for (let block = 0; block < 3; block++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const ch = base.charAt(block * 5 + i);
      if (ch >= "A" && ch <= "Z") flags |= 1 << i;
    }
    suffix += ID_CHARS.charAt(flags);
  }
  return base + suffix;
}

/** Validates and normalizes a queue (Group) id to 18 characters. Returns null when invalid. */
export function normalizeQueueId(raw: string): string | null {
  const id = raw.trim();
  if (!QUEUE_ID_PATTERN.test(id)) return null;
  const id18 = toSalesforceId18(id);
  // An 18-character id whose suffix does not match its first 15 characters is malformed.
  if (id.length === 18 && id.slice(15).toUpperCase() !== id18.slice(15)) return null;
  return id18;
}
