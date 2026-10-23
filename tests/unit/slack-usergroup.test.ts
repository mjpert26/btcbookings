import { describe, expect, it } from "vitest";
import { dryRunChangedMessage, planUsergroupMember, removalProtection, USERGROUP_ID_RE } from "@/server/slack/plan";
import { createSlackClient } from "@/server/slack/client";
import { RetryAfterError } from "@/server/jobs/types";
import { createFakeSlack } from "../helpers/slack-fake";

const live = { mode: "add_and_remove" as const, protected_slack_user_ids: ["UPROT0001"] };

describe("planUsergroupMember", () => {
  it("adds an active member who is not in the group, keeping everyone else", () => {
    expect(planUsergroupMember(live, "active", "UNEW00001", ["UOLD00001"])).toEqual({
      action: "add",
      reason: "Member is active",
      next: ["UOLD00001", "UNEW00001"],
    });
    expect(planUsergroupMember(live, "active", "UOLD00001", ["UOLD00001"])).toMatchObject({ action: "none" });
  });

  it("removes paused and removed members only in add-and-remove mode", () => {
    expect(planUsergroupMember(live, "paused", "UOLD00001", ["UOLD00001", "UKEEP0001"])).toEqual({
      action: "remove",
      reason: "Member paused",
      next: ["UKEEP0001"],
    });
    expect(planUsergroupMember(live, "removed", "UOLD00001", ["UOLD00001", "UKEEP0001"])).toMatchObject({
      action: "remove",
      reason: "Member removed from team",
    });
    expect(planUsergroupMember({ ...live, mode: "add_only" }, "paused", "UOLD00001", ["UOLD00001"])).toMatchObject({ action: "none" });
    expect(planUsergroupMember(live, "paused", "UGONE0001", ["UOLD00001"])).toMatchObject({ action: "none" });
  });

  it("never invites pending members and skips members without a Slack account", () => {
    expect(planUsergroupMember(live, "pending_onboarding", "UPEND0001", [])).toMatchObject({ action: "none" });
    expect(planUsergroupMember(live, "active", null, [])).toMatchObject({ action: "skip", code: "users_not_found" });
  });

  it("keeps protected users and refuses to empty the group", () => {
    expect(planUsergroupMember(live, "paused", "UPROT0001", ["UPROT0001", "UOTHER001"])).toMatchObject({ action: "skip", code: "protected_user" });
    expect(planUsergroupMember(live, "paused", "ULAST0001", ["ULAST0001"])).toMatchObject({ action: "skip", code: "empty_group" });
  });

  it("validates user group ids", () => {
    expect(USERGROUP_ID_RE.test("S0604QSJC")).toBe(true);
    expect(USERGROUP_ID_RE.test("C0604QSJC")).toBe(false);
  });
});

describe("removalProtection", () => {
  it("protects workspace owners, admins and bots", () => {
    expect(removalProtection({ id: "U1", is_admin: true })).toMatchObject({ removable: false, code: "workspace_admin" });
    expect(removalProtection({ id: "U1", is_owner: true })).toMatchObject({ removable: false, code: "workspace_admin" });
    expect(removalProtection({ id: "U1", is_primary_owner: true })).toMatchObject({ removable: false, code: "workspace_admin" });
    expect(removalProtection({ id: "U1", is_bot: true })).toMatchObject({ removable: false, code: "bot_user" });
    expect(removalProtection({ id: "U1" })).toEqual({ removable: true });
  });
});

describe("Slack client user group methods", () => {
  it("lists with a form body, updates with a JSON comma list, and maps 429 to RetryAfterError", async () => {
    const fake = createFakeSlack();
    fake.usergroups.set("S1111111", ["U0000001"]);
    const client = createSlackClient({ token: "xoxb-unit", fetch: fake.fetch });
    expect((await client.usergroupsUsersList("S1111111")).data?.users).toEqual(["U0000001"]);
    expect((await client.usergroupsUsersUpdate("S1111111", ["U0000001", "U0000002"])).ok).toBe(true);
    expect(fake.usergroups.get("S1111111")).toEqual(["U0000001", "U0000002"]);
    const [list, update] = fake.calls;
    expect(list.contentType).toMatch(/x-www-form-urlencoded/);
    expect(update.contentType).toMatch(/application\/json/);
    expect(update.args.users).toBe("U0000001,U0000002");
    expect(update.authorization).toBe("Bearer xoxb-unit");

    fake.force("usergroups.users.update", { status: 429, headers: { "retry-after": "9" }, body: { ok: false, error: "ratelimited" } });
    await expect(client.usergroupsUsersUpdate("S1111111", ["U0000001"])).rejects.toMatchObject({ retryAfterSeconds: 9 });
    await expect(client.usergroupsUsersUpdate("S1111111", [])).resolves.toMatchObject({ ok: false, error: "no_users_provided" });
    fake.force("users.info", { status: 429, headers: { "retry-after": "3" }, body: { ok: false, error: "ratelimited" } });
    await expect(client.usersInfo("U0000001")).rejects.toBeInstanceOf(RetryAfterError);
  });
});

describe("dryRunChangedMessage", () => {
  it("does not claim removals apply when the link is add only", () => {
    const msg = dryRunChangedMessage("user group", false, "add_only");
    expect(msg).toContain("add only");
    expect(msg).toContain("set the mode to add and remove");
    expect(msg).not.toMatch(/removed from the Slack/);
  });

  it("says members are added and removed in add-and-remove mode", () => {
    expect(dryRunChangedMessage("channel", false, "add_and_remove")).toBe(
      "Dry run is off. Members are now added to and removed from the Slack channel.",
    );
  });

  it("says nothing is applied while dry run is on", () => {
    expect(dryRunChangedMessage("user group", true, "add_and_remove")).toBe("Dry run is on. Changes are recorded but not applied.");
  });
});
