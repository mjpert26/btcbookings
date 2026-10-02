"use server";

// TODO(integration): delegate to src/server/slack/admin.ts after merge:
//   addChannelAction      -> addChannel(actor, teamId, { channelId, mode, protectedSlackUserIds, notifyChannelId })
//   updateChannelAction   -> updateChannel(actor, channelConfigId, input)
//   setDryRunAction       -> setDryRun(actor, channelConfigId, dryRun)
//   removeChannelAction   -> removeChannel(actor, channelConfigId)
//   checkHealthAction     -> checkChannelHealth(channelConfigId)   (calls conversations.info)
//   fullResyncAction      -> fullResync(actor, channelConfigId)
// The preview on the Slack page is computed from the roster here; previewChannel()
// compares against the real channel members and should replace it.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { enqueueAfterCommit } from "@/server/ui/jobs";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, ok, pgCode, requestIpHash, str } from "@/server/ui/form";
import { SLACK_CHANNEL_RE, SLACK_USER_RE } from "@/lib/ids";

const userIdList = z
  .string()
  .transform((s) => s.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))
  .pipe(z.array(z.string().regex(SLACK_USER_RE, "Slack user IDs look like U012ABCDEF.")).max(100));

const channelSchema = z.object({
  channelName: z.string().trim().max(80).optional(),
  mode: z.enum(["add_only", "add_and_remove"]),
  protectedSlackUserIds: userIdList,
  notifyChannelId: z.union([z.literal(""), z.string().trim().toUpperCase().regex(SLACK_CHANNEL_RE, "Channel IDs look like C012ABCDEF.")]).transform((v) => (v === "" ? null : v)),
});

const addSchema = channelSchema.extend({
  channelId: z.string().trim().toUpperCase().regex(SLACK_CHANNEL_RE, "Channel IDs start with C or G, for example C012ABCDEF."),
});

function readChannel(fd: FormData) {
  return {
    channelName: str(fd, "channelName").replace(/^#/, "") || undefined,
    mode: str(fd, "mode"),
    protectedSlackUserIds: str(fd, "protectedSlackUserIds"),
    notifyChannelId: str(fd, "notifyChannelId"),
  };
}

async function teamOf(userId: string, configId: string): Promise<string | null> {
  const [r] = await withUser(userId, (tx) => tx<{ team_id: string }[]>`select team_id from app.team_slack_channels where id = ${configId}`);
  return r?.team_id ?? null;
}

export async function addChannelAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(teamId)) return fail("Team not found.");
  const parsed = addSchema.safeParse({ ...readChannel(fd), channelId: str(fd, "channelId") });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const ipHash = await requestIpHash();
  try {
    await withUser(user.id, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.team_slack_channels (team_id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id)
        values (${teamId}, ${v.channelId}, ${v.channelName ?? null}, ${v.mode}, true, ${v.protectedSlackUserIds}, ${v.notifyChannelId})
        returning id
      `;
      await writeAudit(tx, { actorUserId: user.id, action: "slack.channel_add", entityType: "team_slack_channel", entityId: row.id, after: { teamId, ...v, dryRun: true }, ipHash });
    });
  } catch (err) {
    if (pgCode(err) === "23505") return fail("That channel is already configured for this team.", { channelId: "Already configured." });
    throw err;
  }
  revalidatePath(`/admin/teams/${teamId}/slack`);
  return ok("Channel added in dry-run mode. Review the preview before turning dry run off.");
}

export async function updateChannelAction(configId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  const parsed = channelSchema.safeParse(readChannel(fd));
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const ipHash = await requestIpHash();
  const teamId = await withUser(user.id, async (tx) => {
    const [before] = await tx<{ team_id: string; mode: string; protected_slack_user_ids: string[]; notify_channel_id: string | null; channel_name: string | null }[]>`
      select team_id, mode, protected_slack_user_ids, notify_channel_id, channel_name from app.team_slack_channels where id = ${configId} for update
    `;
    if (!before) return null;
    await tx`
      update app.team_slack_channels set channel_name = ${v.channelName ?? before.channel_name}, mode = ${v.mode},
        protected_slack_user_ids = ${v.protectedSlackUserIds}, notify_channel_id = ${v.notifyChannelId}
      where id = ${configId}
    `;
    await writeAudit(tx, { actorUserId: user.id, action: "slack.channel_update", entityType: "team_slack_channel", entityId: configId, before, after: v, ipHash });
    return before.team_id;
  });
  if (!teamId) return fail("Channel not found.");
  revalidatePath(`/admin/teams/${teamId}/slack`);
  return ok("Channel saved.");
}

export async function setDryRunAction(configId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  const dryRun = bool(fd, "dryRun");
  const ipHash = await requestIpHash();
  const teamId = await withUser(user.id, async (tx) => {
    const [r] = await tx<{ team_id: string }[]>`update app.team_slack_channels set dry_run = ${dryRun} where id = ${configId} returning team_id`;
    if (!r) return null;
    await writeAudit(tx, { actorUserId: user.id, action: dryRun ? "slack.dry_run_on" : "slack.dry_run_off", entityType: "team_slack_channel", entityId: configId, after: { dryRun }, ipHash });
    return r.team_id;
  });
  if (!teamId) return fail("Channel not found.");
  revalidatePath(`/admin/teams/${teamId}/slack`);
  return ok(dryRun ? "Dry run is on. Changes are recorded but not applied." : "Dry run is off. Membership changes now apply to the Slack channel.");
}

export async function removeChannelAction(configId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  const ipHash = await requestIpHash();
  const teamId = await withUser(user.id, async (tx) => {
    const [r] = await tx<{ team_id: string; channel_id: string }[]>`delete from app.team_slack_channels where id = ${configId} returning team_id, channel_id`;
    if (!r) return null;
    await writeAudit(tx, { actorUserId: user.id, action: "slack.channel_remove", entityType: "team_slack_channel", entityId: configId, before: { channelId: r.channel_id }, ipHash });
    return r.team_id;
  });
  if (!teamId) return fail("Channel not found.");
  revalidatePath(`/admin/teams/${teamId}/slack`);
  return ok("Channel removed. Existing Slack members were not changed.");
}

export async function checkHealthAction(configId: string): Promise<ActionState> {
  await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  return fail("Live health checks call the Slack API and are handled by the Slack module. The status shown is from the last sync.");
}

export async function fullResyncAction(configId: string): Promise<ActionState> {
  const user = await requireAdmin();
  if (!isUuid(configId)) return fail("Channel not found.");
  const teamId = await teamOf(user.id, configId);
  if (!teamId) return fail("Channel not found.");
  const ipHash = await requestIpHash();
  const stamp = new Date().toISOString().slice(0, 16);
  const members = await withUser(user.id, async (tx) => {
    const rows = await tx<{ id: string }[]>`select id from app.team_members where team_id = ${teamId} and status in ('active', 'paused')`;
    await writeAudit(tx, { actorUserId: user.id, action: "slack.full_resync", entityType: "team_slack_channel", entityId: configId, after: { members: rows.length }, ipHash });
    return rows;
  });
  await enqueueAfterCommit(
    members.map((m) => ({
      kind: "slack_membership_sync",
      payload: { teamId, teamMemberId: m.id },
      idempotencyKey: `resync:${configId}:${m.id}:${stamp}`,
      teamId,
    })),
  );
  revalidatePath(`/admin/teams/${teamId}/slack`);
  return ok(`Full resync queued for ${members.length} member${members.length === 1 ? "" : "s"}.`);
}
