import { describe, expect, it } from "vitest";
import {
  computePreview,
  intendedAction,
  noticeReason,
  noticeText,
  planMemberAction,
  CHANNEL_ID_RE,
  SLACK_USER_ID_RE,
  type PreviewMember,
} from "@/server/slack/plan";
import { createSlackClient, listAllChannelMembers } from "@/server/slack/client";
import { RetryAfterError } from "@/server/jobs/types";
import { createFakeSlack } from "../helpers/slack-fake";

const addOnly = { mode: "add_only" as const, protected_slack_user_ids: [] };
const addRemove = { mode: "add_and_remove" as const, protected_slack_user_ids: ["UPROT0001"] };

describe("planMemberAction", () => {
  it("invites active members in both modes", () => {
    expect(planMemberAction(addOnly, "active", "U1234567").action).toBe("invite");
    expect(planMemberAction(addRemove, "active", "U1234567").action).toBe("invite");
  });

  it("never removes in add_only mode", () => {
    expect(planMemberAction(addOnly, "paused", "U1234567").action).toBe("none");
    expect(planMemberAction(addOnly, "removed", "U1234567").action).toBe("none");
  });

  it("kicks paused and removed members in add_and_remove mode", () => {
    expect(planMemberAction(addRemove, "paused", "U1234567")).toMatchObject({ action: "kick", reason: "Member paused" });
    expect(planMemberAction(addRemove, "removed", "U1234567")).toMatchObject({ action: "kick", reason: "Member removed from team" });
  });

  it("never kicks protected users", () => {
    expect(planMemberAction(addRemove, "paused", "UPROT0001")).toMatchObject({ action: "skip", code: "protected_user" });
    // Protection does not block invites.
    expect(planMemberAction(addRemove, "active", "UPROT0001").action).toBe("invite");
  });

  it("does nothing for pending_onboarding members until they are active", () => {
    expect(planMemberAction(addOnly, "pending_onboarding", "U1234567").action).toBe("none");
    expect(planMemberAction(addRemove, "pending_onboarding", "U1234567").action).toBe("none");
    expect(intendedAction("add_and_remove", "pending_onboarding")).toBe("none");
  });

  it("skips with a warning when the Slack account is unknown", () => {
    expect(planMemberAction(addRemove, "active", null)).toMatchObject({ action: "skip", code: "users_not_found" });
    // No identity is needed when there is nothing to do.
    expect(planMemberAction(addOnly, "paused", null).action).toBe("none");
  });
});

describe("computePreview", () => {
  const m = (id: string, status: PreviewMember["status"], slackUserId: string | null): PreviewMember => ({
    teamMemberId: id,
    email: `${id}@bigthinkcapital.com`,
    status,
    slackUserId,
  });
  const members = [
    m("a", "active", "UA0000001"), // not in channel -> add
    m("b", "active", "UB0000001"), // in channel -> unchanged
    m("c", "paused", "UC0000001"), // in channel -> remove (add_and_remove)
    m("d", "paused", "UPROT0001"), // protected
    m("e", "pending_onboarding", "UE0000001"), // in channel but pending -> untouched
    m("f", "active", null), // unresolved
    m("g", "paused", "UG0000001"), // not in channel -> unchanged
  ];
  const inChannel = ["UB0000001", "UC0000001", "UPROT0001", "UE0000001", "UOUTSIDER1"];

  it("lists adds and removals for add_and_remove", () => {
    const p = computePreview(addRemove, members, inChannel);
    expect(p.wouldAdd.map((x) => x.teamMemberId)).toEqual(["a"]);
    expect(p.wouldRemove.map((x) => x.teamMemberId)).toEqual(["c"]);
    expect(p.protectedKept.map((x) => x.teamMemberId)).toEqual(["d"]);
    expect(p.unresolved.map((x) => x.teamMemberId)).toEqual(["f"]);
    expect(p.unchanged).toBe(3);
  });

  it("never proposes removals for add_only or for non-team channel members", () => {
    const p = computePreview(addOnly, members, inChannel);
    expect(p.wouldRemove).toEqual([]);
    expect(p.protectedKept).toEqual([]);
    expect(p.wouldAdd.map((x) => x.teamMemberId)).toEqual(["a"]);
  });
});

describe("notices and ids", () => {
  it("formats admin notices", () => {
    expect(noticeText("invite", "U1234567", "C1234567", "SDR", noticeReason("poll"))).toBe(
      "BTC Scheduler added <@U1234567> to <#C1234567> (team: SDR, reason: queue sync)",
    );
    expect(noticeText("kick", "U1234567", "C1234567", "SDR", noticeReason("admin"))).toBe(
      "BTC Scheduler removed <@U1234567> from <#C1234567> (team: SDR, reason: admin change)",
    );
    expect(noticeReason(null)).toBe("membership sync");
  });

  it("validates Slack ids", () => {
    expect(CHANNEL_ID_RE.test("C0123ABCD")).toBe(true);
    expect(CHANNEL_ID_RE.test("G0123ABCD")).toBe(true);
    expect(CHANNEL_ID_RE.test("#general")).toBe(false);
    expect(CHANNEL_ID_RE.test("c0123abcd")).toBe(false);
    expect(SLACK_USER_ID_RE.test("U0123ABCD")).toBe(true);
    expect(SLACK_USER_ID_RE.test("W0123ABCD")).toBe(true);
    expect(SLACK_USER_ID_RE.test("C0123ABCD")).toBe(false);
  });
});

describe("Slack client", () => {
  it("sends JSON for write methods and form bodies for read methods, with a bearer token", async () => {
    const fake = createFakeSlack();
    fake.addChannel({ id: "C1111111" });
    fake.users.set("a@bigthinkcapital.com", "UA0000001");
    const client = createSlackClient({ token: "xoxb-secret", fetch: fake.fetch });

    expect((await client.usersLookupByEmail("a@bigthinkcapital.com")).ok).toBe(true);
    expect((await client.conversationsInvite("C1111111", "UA0000001")).ok).toBe(true);
    const again = await client.conversationsInvite("C1111111", "UA0000001");
    expect(again).toMatchObject({ ok: false, error: "already_in_channel" });

    const [lookup, invite] = fake.calls;
    expect(lookup.contentType).toBe("application/x-www-form-urlencoded");
    expect(lookup.args).toEqual({ email: "a@bigthinkcapital.com" });
    expect(invite.contentType).toMatch(/^application\/json/);
    expect(invite.args).toEqual({ channel: "C1111111", users: "UA0000001" });
    expect(invite.authorization).toBe("Bearer xoxb-secret");
  });

  it("throws RetryAfterError on HTTP 429 and on ratelimited, without leaking the token", async () => {
    const fake = createFakeSlack();
    const client = createSlackClient({ token: "xoxb-secret", fetch: fake.fetch });
    fake.force("conversations.invite", { status: 429, headers: { "retry-after": "17" }, body: { ok: false, error: "ratelimited" } });
    const e = await client.conversationsInvite("C1111111", "U1").catch((x) => x);
    expect(e).toBeInstanceOf(RetryAfterError);
    expect((e as RetryAfterError).retryAfterSeconds).toBe(17);
    expect(String(e.message)).not.toContain("xoxb");

    fake.force("conversations.kick", { status: 200, body: { ok: false, error: "ratelimited" } });
    const e2 = await client.conversationsKick("C1111111", "U1").catch((x) => x);
    expect(e2).toBeInstanceOf(RetryAfterError);
    expect((e2 as RetryAfterError).retryAfterSeconds).toBe(30);
  });

  it("maps non-JSON server errors to http_<status>", async () => {
    const client = createSlackClient({
      token: "xoxb-secret",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    expect(await client.conversationsInfo("C1111111")).toMatchObject({ ok: false, error: "http_502" });
  });

  it("paginates conversations.members", async () => {
    const fake = createFakeSlack();
    const ch = fake.addChannel({ id: "C1111111" });
    ["U0000001", "U0000002", "U0000003", "U0000004"].forEach((u) => ch.members.add(u));
    const client = createSlackClient({ token: "xoxb-secret", fetch: fake.fetch });
    const res = await listAllChannelMembers(client, "C1111111");
    expect(res.data?.members.sort()).toEqual(["U0000001", "U0000002", "U0000003", "U0000004", "UBOT00001"].sort());
    expect(fake.callsTo("conversations.members").length).toBe(3);
  });
});
