import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { previewChannel, SlackAdminError, type PreviewResult } from "@/server/slack/admin";
import { SlackNotConfiguredError } from "@/server/slack/client";
import { Notice } from "@/components/ui/Toast";
import { isUuid } from "@/server/ui/form";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { ButtonLink } from "@/components/ui/Button";
import { ActionButton } from "@/components/app/ActionButton";
import { ConfirmAction } from "@/components/app/ConfirmAction";
import { formatDateTime, formatRelative } from "@/lib/format";
import {
  addChannelAction,
  checkHealthAction,
  checkUsergroupHealthAction,
  fullResyncAction,
  linkUsergroupAction,
  removeChannelAction,
  resyncUsergroupAction,
  setDryRunAction,
  setUsergroupDryRunAction,
  unlinkUsergroupAction,
  updateChannelAction,
  updateUsergroupAction,
} from "../../../_actions/slack";
import { AddChannelForm, DryRunToggle, EditChannelDialog, EditUsergroupDialog, LinkUsergroupForm } from "./SlackForms";

export const metadata: Metadata = { title: "Slack channels" };

type Channel = {
  id: string;
  channel_id: string;
  channel_name: string | null;
  mode: string;
  dry_run: boolean;
  protected_slack_user_ids: string[];
  notify_channel_id: string | null;
  health: string;
  last_error: string | null;
  last_checked_at: Date | null;
};

type Usergroup = {
  id: string;
  usergroup_id: string;
  usergroup_handle: string | null;
  mode: string;
  dry_run: boolean;
  protected_slack_user_ids: string[];
  health: string;
  last_error: string | null;
  last_checked_at: Date | null;
};

type ActionRow = { id: string; channel_config_id: string | null; email: string | null; action: string; dry_run: boolean; outcome: string; error_code: string | null; detail: string | null; created_at: Date };

type Preview = { ok: true; result: PreviewResult; names: Map<string, string> } | { ok: false; error: string };

/** Runs previewChannel (reads the channel's real members from Slack) and resolves member names. */
async function loadPreview(userId: string, channelConfigId: string): Promise<Preview> {
  try {
    const result = await previewChannel(userId, channelConfigId);
    const ids = [...result.wouldAdd, ...result.wouldRemove, ...result.protectedKept, ...result.unresolved].map((m) => m.teamMemberId);
    const rows = ids.length
      ? await withUser(userId, (tx) => tx<{ id: string; name: string }[]>`
          select tm.id, u.name from app.team_members tm join app.users u on u.id = tm.user_id where tm.id = any(${ids}::uuid[])
        `)
      : [];
    return { ok: true, result, names: new Map(rows.map((r) => [r.id, r.name])) };
  } catch (err) {
    if (err instanceof SlackAdminError && err.code !== "forbidden") return { ok: false, error: err.message };
    if (err instanceof SlackNotConfiguredError) return { ok: false, error: "Slack is not configured on this deployment (SLACK_BOT_TOKEN is not set), so the channel's members cannot be read." };
    throw err;
  }
}

export default async function TeamSlackPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preview?: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const previewId = sp.preview && isUuid(sp.preview) ? sp.preview : null;

  const data = await withUser(user.id, async (tx) => {
    const [team] = await tx<{ id: string; name: string }[]>`select id, name from app.teams where id = ${id}`;
    if (!team) return null;
    const channels = await tx<Channel[]>`
      select id, channel_id, channel_name, mode, dry_run, protected_slack_user_ids, notify_channel_id, health, last_error, last_checked_at
      from app.team_slack_channels where team_id = ${id} order by created_at
    `;
    const actions = await tx<ActionRow[]>`
      select a.id, a.channel_config_id, tm.email, a.action, a.dry_run, a.outcome, a.error_code, a.detail, a.created_at
      from app.slack_channel_actions a left join app.team_members tm on tm.id = a.team_member_id
      where a.team_id = ${id}
      order by a.created_at desc
      limit 25
    `;
    const [usergroup] = await tx<Usergroup[]>`
      select id, usergroup_id, usergroup_handle, mode, dry_run, protected_slack_user_ids, health, last_error, last_checked_at
      from app.team_slack_usergroups where team_id = ${id}
    `;
    const usergroupActions = await tx<ActionRow[]>`
      select a.id, a.usergroup_config_id as channel_config_id, tm.email, a.action, a.dry_run, a.outcome, a.error_code, a.detail, a.created_at
      from app.slack_usergroup_actions a left join app.team_members tm on tm.id = a.team_member_id
      where a.team_id = ${id}
      order by a.created_at desc
      limit 25
    `;
    return { team, channels, actions, usergroup: usergroup ?? null, usergroupActions };
  });
  if (!data) notFound();
  const { team, channels, actions, usergroup, usergroupActions } = data;
  const preview = previewId ? channels.find((c) => c.id === previewId) : undefined;
  const previewData = preview ? await loadPreview(user.id, preview.id) : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/admin", label: "Admin" },
          { href: `/teams/${team.id}`, label: team.name },
        ]}
        title="Slack channels and user group"
        description="Active team members are invited to these channels and the team's user group. In add-and-remove mode, paused members are removed."
      />

      {channels.length === 0 ? (
        <EmptyState className="mb-6" title="No channels configured" description="Add a channel below. It starts in dry-run mode so you can preview the effect." />
      ) : (
        <ul className="mb-6 space-y-4">
          {channels.map((c) => {
            const label = c.channel_name ? `#${c.channel_name}` : c.channel_id;
            return (
              <li key={c.id}>
                <Card aria-labelledby={`ch-${c.id}`}>
                  <CardHeader
                    id={`ch-${c.id}`}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        {label}
                        <span className="font-mono text-xs font-normal text-muted">{c.channel_id}</span>
                        {c.dry_run ? (
                          <Badge tone="navy" className="tracking-wider">
                            DRY RUN
                          </Badge>
                        ) : (
                          <Badge tone="success">LIVE</Badge>
                        )}
                        <StatusBadge status={c.health} />
                      </span>
                    }
                    description={`${c.mode === "add_only" ? "Add only" : "Add and remove"} · checked ${formatRelative(c.last_checked_at)}`}
                    actions={
                      <>
                        <ButtonLink href={`/admin/teams/${team.id}/slack?preview=${c.id}#preview`} variant="secondary" size="sm">
                          Preview<span className="sr-only"> {label}</span>
                        </ButtonLink>
                        <EditChannelDialog
                          action={updateChannelAction.bind(null, c.id)}
                          label={label}
                          values={{ mode: c.mode, protectedSlackUserIds: c.protected_slack_user_ids.join(", "), notifyChannelId: c.notify_channel_id ?? "" }}
                        />
                      </>
                    }
                  />
                  <CardBody className="grid gap-5 md:grid-cols-2">
                    <div className="space-y-3">
                      <DryRunToggle action={setDryRunAction.bind(null, c.id)} dryRun={c.dry_run} label={label} />
                      <dl className="space-y-1 text-sm">
                        <div className="flex gap-2">
                          <dt className="text-muted">Protected users:</dt>
                          <dd className="font-mono text-xs">{c.protected_slack_user_ids.length ? c.protected_slack_user_ids.join(", ") : "None"}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="text-muted">Notify channel:</dt>
                          <dd className="font-mono text-xs">{c.notify_channel_id ?? "None"}</dd>
                        </div>
                      </dl>
                    </div>
                    <div className="space-y-3">
                      {c.health === "bot_not_in_channel" ? (
                        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
                          <p className="font-semibold text-danger">The bot is not in this channel</p>
                          <p className="mt-1 text-ink">
                            Open {label} in Slack and run <code className="rounded bg-surface px-1 font-mono">/invite @BTC Scheduler</code>, then check health again. Public channels can also be joined automatically if the app has the channels:join scope.
                          </p>
                        </div>
                      ) : c.health === "error" ? (
                        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
                          <p className="font-semibold text-danger">Last check failed</p>
                          <p className="mt-1 font-mono text-xs text-ink">{c.last_error ?? "Unknown error"}</p>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <ActionButton action={checkHealthAction.bind(null, c.id)} size="sm" pendingLabel="Checking…">
                          Check health
                        </ActionButton>
                        <ActionButton action={fullResyncAction.bind(null, c.id)} size="sm" pendingLabel="Queuing…">
                          Full resync
                        </ActionButton>
                        <ConfirmAction
                          action={removeChannelAction.bind(null, c.id)}
                          trigger="Remove"
                          triggerSize="sm"
                          triggerVariant="ghost"
                          title={`Remove ${label}?`}
                          description="Sync stops for this channel. Current Slack members are not changed."
                          confirmLabel="Remove channel"
                        />
                      </div>
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {preview && previewData ? <PreviewCard channel={preview} preview={previewData} teamId={team.id} /> : null}

      <Card className="mb-6" aria-labelledby="add-h">
        <CardHeader id="add-h" title="Add a channel" />
        <CardBody>
          <AddChannelForm action={addChannelAction.bind(null, team.id)} />
        </CardBody>
      </Card>

      <UsergroupCard teamId={team.id} usergroup={usergroup} />

      <ActionsTable title="Recent user group actions" caption="Recent Slack user group actions" id="ug-recent-h" actions={usergroupActions} timezone={user.timezone} hidden={!usergroup && usergroupActions.length === 0} />

      <ActionsTable title="Recent channel actions" caption="Recent Slack actions" id="recent-h" actions={actions} timezone={user.timezone} />
    </>
  );
}

function UsergroupCard({ teamId, usergroup }: { teamId: string; usergroup: Usergroup | null }) {
  if (!usergroup) {
    return (
      <Card className="mb-6" aria-labelledby="ug-h">
        <CardHeader
          id="ug-h"
          title="Slack user group"
          description="Optional. Keeps the partner's Slack user group (for example @partner-team) in step with the roster, the same way as channels."
        />
        <CardBody>
          <LinkUsergroupForm action={linkUsergroupAction.bind(null, teamId)} />
        </CardBody>
      </Card>
    );
  }
  const label = usergroup.usergroup_handle ? `@${usergroup.usergroup_handle}` : usergroup.usergroup_id;
  return (
    <Card className="mb-6" aria-labelledby="ug-h">
      <CardHeader
        id="ug-h"
        title={
          <span className="flex flex-wrap items-center gap-2">
            Slack user group {label}
            <span className="font-mono text-xs font-normal text-muted">{usergroup.usergroup_id}</span>
            {usergroup.dry_run ? (
              <Badge tone="navy" className="tracking-wider">
                DRY RUN
              </Badge>
            ) : (
              <Badge tone="success">LIVE</Badge>
            )}
            <StatusBadge status={usergroup.health} />
          </span>
        }
        description={`${usergroup.mode === "add_only" ? "Add only" : "Add and remove"} · checked ${formatRelative(usergroup.last_checked_at)}`}
        actions={
          <EditUsergroupDialog
            action={updateUsergroupAction.bind(null, usergroup.id)}
            label={label}
            values={{ mode: usergroup.mode, handle: usergroup.usergroup_handle ?? "", protectedSlackUserIds: usergroup.protected_slack_user_ids.join(", ") }}
          />
        }
      />
      <CardBody className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <DryRunToggle action={setUsergroupDryRunAction.bind(null, usergroup.id)} dryRun={usergroup.dry_run} label={label} />
          <p className="text-sm">
            <span className="text-muted">Protected users: </span>
            <span className="font-mono text-xs">{usergroup.protected_slack_user_ids.length ? usergroup.protected_slack_user_ids.join(", ") : "None"}</span>
          </p>
          <p className="text-xs text-muted">Workspace owners, workspace admins and bots are never removed.</p>
        </div>
        <div className="space-y-3">
          {usergroup.last_error ? (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
              <p className="font-semibold text-danger">Last check failed</p>
              <p className="mt-1 font-mono text-xs text-ink">{usergroup.last_error}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <ActionButton action={checkUsergroupHealthAction.bind(null, usergroup.id)} size="sm" pendingLabel="Checking…">
              Check health
            </ActionButton>
            <ActionButton action={resyncUsergroupAction.bind(null, usergroup.id)} size="sm" pendingLabel="Queuing…">
              Full resync
            </ActionButton>
            <ConfirmAction
              action={unlinkUsergroupAction.bind(null, usergroup.id)}
              trigger="Unlink"
              triggerSize="sm"
              triggerVariant="ghost"
              title={`Unlink ${label}?`}
              description="Sync stops for this user group. Current Slack members are not changed."
              confirmLabel="Unlink user group"
            />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function ActionsTable({ title, caption, id, actions, timezone, hidden }: { title: string; caption: string; id: string; actions: ActionRow[]; timezone: string; hidden?: boolean }) {
  if (hidden) return null;
  return (
      <Card className="mb-6" aria-labelledby={id}>
        <CardHeader id={id} title={title} description="What the Slack sync did or, in dry run, would have done." />
        {actions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No actions recorded yet.</p>
        ) : (
          <Table caption={caption}>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Member</TH>
                <TH>Action</TH>
                <TH>Outcome</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {actions.map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(a.created_at, timezone)}</TD>
                  <TD>{a.email ?? "—"}</TD>
                  <TD>
                    {a.action} {a.dry_run ? <Badge tone="navy">DRY RUN</Badge> : null}
                  </TD>
                  <TD>
                    <Badge tone={a.outcome === "error" ? "danger" : a.outcome === "done" ? "success" : "neutral"}>{a.outcome.replace("_", " ")}</Badge>
                  </TD>
                  <TD className="text-xs text-muted">{a.error_code ?? a.detail ?? ""}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
  );
}

function PreviewCard({ channel, preview, teamId }: { channel: Channel; preview: Preview; teamId: string }) {
  const label = channel.channel_name ? `#${channel.channel_name}` : channel.channel_id;
  const close = (
    <Link href={`/admin/teams/${teamId}/slack`} className="text-sm font-medium text-primary hover:underline">
      Close preview
    </Link>
  );

  if (!preview.ok) {
    return (
      <Card className="mb-6 border-danger/40" aria-labelledby="preview">
        <CardHeader id="preview" title={`Preview for ${label}`} actions={close} />
        <CardBody>
          <Notice tone="warning" title="Could not read the channel from Slack">
            {preview.error}
          </Notice>
        </CardBody>
      </Card>
    );
  }

  const { result, names } = preview;
  const list = (rows: PreviewResult["wouldAdd"]) =>
    rows.length ? (
      <ul className="space-y-1 text-sm">
        {rows.map((m) => (
          <li key={m.teamMemberId}>
            <span className="font-medium text-navy">{names.get(m.teamMemberId) ?? m.email}</span> <span className="text-xs text-muted">{m.email}</span>
            {m.slackUserId ? <span className="ml-1 font-mono text-xs text-muted">{m.slackUserId}</span> : null}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-muted">None</p>
    );

  return (
    <Card className="mb-6 border-primary/40" aria-labelledby="preview">
      <CardHeader
        id="preview"
        title={`Preview for ${label}`}
        description={`Compares the roster with the ${result.channelMemberCount} current member${result.channelMemberCount === 1 ? "" : "s"} of the channel in Slack. Nothing is changed. ${result.unchanged} member${result.unchanged === 1 ? " is" : "s are"} already in the right state.`}
        actions={close}
      />
      <CardBody className="grid gap-6 md:grid-cols-3">
        <section aria-labelledby="pv-add">
          <h3 id="pv-add" className="mb-2 text-sm font-semibold text-success">
            Would add ({result.wouldAdd.length})
          </h3>
          {list(result.wouldAdd)}
        </section>
        <section aria-labelledby="pv-remove">
          <h3 id="pv-remove" className="mb-2 text-sm font-semibold text-danger">
            Would remove ({result.wouldRemove.length})
          </h3>
          {channel.mode === "add_only" ? <p className="text-sm text-muted">Add-only mode never removes members.</p> : list(result.wouldRemove)}
          {result.protectedKept.length ? (
            <p className="mt-2 text-xs text-muted">
              {result.protectedKept.length} protected paused member{result.protectedKept.length === 1 ? " is" : "s are"} kept.
            </p>
          ) : null}
        </section>
        <section aria-labelledby="pv-skip">
          <h3 id="pv-skip" className="mb-2 text-sm font-semibold text-muted">
            Skipped, no Slack account found ({result.unresolved.length})
          </h3>
          {list(result.unresolved)}
        </section>
      </CardBody>
    </Card>
  );
}
