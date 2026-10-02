"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { addChannel, checkChannelHealth, fullResync, removeChannel, setDryRun, updateChannel } from "@/server/slack/admin";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, ok, str } from "@/server/ui/form";
import { adminError, audited } from "@/server/ui/admin";
import { SLACK_CHANNEL_RE, SLACK_USER_RE } from "@/lib/ids";

/**
 * Admin actions for Slack channel sync. Each action parses the form and delegates to
 * src/server/slack/admin.ts, which requires a global admin, talks to Slack where needed and
 * writes the audit entry in the same transaction as the change.
 */

const SLACK_PAGE = "/admin/teams/[id]/slack";

const userIdList = z
  .string()
  .transform((s) => s.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))
  .pipe(z.array(z.string().regex(SLACK_USER_RE, "Slack user IDs look like U012ABCDEF.")).max(100));

const channelSchema = z.object({
  mode: z.enum(["add_only", "add_and_remove"]),
  protectedSlackUserIds: userIdList,
  notifyChannelId: z
    .union([z.literal(""), z.string().trim().toUpperCase().regex(SLACK_CHANNEL_RE, "Channel IDs look like C012ABCDEF.")])
    .transform((v) => (v === "" ? null : v)),
});

const addSchema = channelSchema.extend({
  channelId: z.string().trim().toUpperCase().regex(SLACK_CHANNEL_RE, "Channel IDs start with C or G, for example C012ABCDEF."),
});

function readChannel(fd: FormData) {
  return {
    mode: str(fd, "mode"),
    protectedSlackUserIds: str(fd, "protectedSlackUserIds"),
    notifyChannelId: str(fd, "notifyChannelId"),
  };
}

const HEALTH_MESSAGES: Record<string, string> = {
  ok: "Channel is healthy.",
  bot_not_in_channel: "The bot is not in this channel. Invite it with /invite @BTC Scheduler, then check again.",
  error: "Slack reported a problem with this channel. See the details on the card.",
  unknown: "Slack did not confirm the channel state. See the details on the card.",
};

export async function addChannelAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  const parsed = addSchema.safeParse({ ...readChannel(fd), channelId: str(fd, "channelId") });
  if (!parsed.success) return invalid(parsed.error);
  let row;
  try {
    row = await audited(() => addChannel(user.id, teamId, parsed.data));
  } catch (err) {
    return adminError(err, { channelId: "Check this channel ID." });
  }
  revalidatePath(`/admin/teams/${teamId}/slack`);
  const label = row.channel_name ? `#${row.channel_name}` : row.channel_id;
  return ok(`${label} added in dry-run mode (health: ${row.health.replace(/_/g, " ")}). Review the preview before turning dry run off.`);
}

export async function updateChannelAction(configId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  const parsed = channelSchema.safeParse(readChannel(fd));
  if (!parsed.success) return invalid(parsed.error);
  try {
    await audited(() => updateChannel(user.id, configId, parsed.data));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(SLACK_PAGE, "page");
  return ok("Channel saved.");
}

export async function setDryRunAction(configId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  const dryRun = bool(fd, "dryRun");
  try {
    await audited(() => setDryRun(user.id, configId, dryRun));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(SLACK_PAGE, "page");
  return ok(dryRun ? "Dry run is on. Changes are recorded but not applied." : "Dry run is off. Membership changes now apply to the Slack channel.");
}

export async function removeChannelAction(configId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  try {
    await audited(() => removeChannel(user.id, configId));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(SLACK_PAGE, "page");
  return ok("Channel removed. Existing Slack members were not changed.");
}

export async function checkHealthAction(configId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  let row;
  try {
    row = await audited(() => checkChannelHealth(user.id, configId));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(SLACK_PAGE, "page");
  const message = HEALTH_MESSAGES[row.health] ?? `Health: ${row.health}.`;
  return row.health === "ok" ? ok(message) : fail(row.last_error ? `${message} ${row.last_error}` : message);
}

export async function fullResyncAction(configId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  let res;
  try {
    res = await audited(() => fullResync(user.id, configId));
  } catch (err) {
    return adminError(err);
  }
  revalidatePath(SLACK_PAGE, "page");
  return ok(`Full resync queued for ${res.enqueued} member${res.enqueued === 1 ? "" : "s"}.`);
}
