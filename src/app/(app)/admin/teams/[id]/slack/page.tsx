import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { withUser, type Tx } from "@/server/db/client";
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
import { addChannelAction, checkHealthAction, fullResyncAction, removeChannelAction, setDryRunAction, updateChannelAction } from "../../../_actions/slack";
import { AddChannelForm, DryRunToggle, EditChannelDialog } from "./SlackForms";

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

type ActionRow = { id: string; channel_config_id: string | null; email: string | null; action: string; dry_run: boolean; outcome: string; error_code: string | null; detail: string | null; created_at: Date };

/** slack_channel_actions is created by the Slack module's migration; it may not exist yet on this branch. */
async function recentActions(tx: Tx, teamId: string): Promise<ActionRow[] | null> {
  const [exists] = await tx<{ ok: boolean }[]>`select to_regclass('app.slack_channel_actions') is not null as ok`;
  if (!exists?.ok) return null;
  return tx<ActionRow[]>`
    select a.id, a.channel_config_id, tm.email, a.action, a.dry_run, a.outcome, a.error_code, a.detail, a.created_at
    from app.slack_channel_actions a left join app.team_members tm on tm.id = a.team_member_id
    where a.team_id = ${teamId}
    order by a.created_at desc
    limit 25
  `;
}

type PreviewMember = { id: string; name: string | null; email: string; status: string; slack_user_id: string | null };

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
    const actions = await recentActions(tx, id);
    const members = previewId
      ? await tx<PreviewMember[]>`
          select tm.id, u.name, tm.email, tm.status, si.slack_user_id
          from app.team_members tm
          left join app.users u on u.id = tm.user_id
          left join app.slack_identities si on si.user_id = tm.user_id
          where tm.team_id = ${id}
          order by coalesce(u.name, tm.email::text)
        `
      : [];
    return { team, channels, actions, members };
  });
  if (!data) notFound();
  const { team, channels, actions, members } = data;
  const preview = previewId ? channels.find((c) => c.id === previewId) : undefined;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/admin", label: "Admin" },
          { href: `/teams/${team.id}`, label: team.name },
        ]}
        title="Slack channels"
        description="Active team members are invited to these channels. In add-and-remove mode, paused members are removed."
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
                          values={{ channelName: c.channel_name ?? "", mode: c.mode, protectedSlackUserIds: c.protected_slack_user_ids.join(", "), notifyChannelId: c.notify_channel_id ?? "" }}
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

      {preview ? <PreviewCard channel={preview} members={members} teamId={team.id} /> : null}

      <Card className="mb-6" aria-labelledby="add-h">
        <CardHeader id="add-h" title="Add a channel" />
        <CardBody>
          <AddChannelForm action={addChannelAction.bind(null, team.id)} />
        </CardBody>
      </Card>

      <Card aria-labelledby="recent-h">
        <CardHeader id="recent-h" title="Recent actions" description="What the Slack sync did or, in dry run, would have done." />
        {actions === null ? (
          <p className="px-5 py-4 text-sm text-muted">The action log becomes available once the Slack module is installed.</p>
        ) : actions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No actions recorded yet.</p>
        ) : (
          <Table caption="Recent Slack actions">
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
                  <TD className="whitespace-nowrap">{formatDateTime(a.created_at, user.timezone)}</TD>
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
    </>
  );
}

function PreviewCard({ channel, members, teamId }: { channel: Channel; members: PreviewMember[]; teamId: string }) {
  const protectedIds = new Set(channel.protected_slack_user_ids);
  const add = members.filter((m) => m.status === "active" && m.slack_user_id);
  const remove = channel.mode === "add_and_remove" ? members.filter((m) => m.status === "paused" && m.slack_user_id && !protectedIds.has(m.slack_user_id)) : [];
  const skipped = members.filter((m) => !m.slack_user_id && m.status !== "pending_onboarding");
  const keep = members.filter((m) => m.status === "paused" && m.slack_user_id && (channel.mode === "add_only" || protectedIds.has(m.slack_user_id)));
  const label = channel.channel_name ? `#${channel.channel_name}` : channel.channel_id;

  const list = (rows: PreviewMember[]) =>
    rows.length ? (
      <ul className="space-y-1 text-sm">
        {rows.map((m) => (
          <li key={m.id}>
            <span className="font-medium text-navy">{m.name ?? m.email}</span> <span className="text-xs text-muted">{m.email}</span>
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
        description="Based on the current roster and known Slack accounts. Members already in the channel are not invited again; the live sync compares with actual channel members."
        actions={
          <Link href={`/admin/teams/${teamId}/slack`} className="text-sm font-medium text-primary hover:underline">
            Close preview
          </Link>
        }
      />
      <CardBody className="grid gap-6 md:grid-cols-3">
        <section aria-labelledby="pv-add">
          <h3 id="pv-add" className="mb-2 text-sm font-semibold text-success">
            Would add ({add.length})
          </h3>
          {list(add)}
        </section>
        <section aria-labelledby="pv-remove">
          <h3 id="pv-remove" className="mb-2 text-sm font-semibold text-danger">
            Would remove ({remove.length})
          </h3>
          {channel.mode === "add_only" ? <p className="text-sm text-muted">Add-only mode never removes members.</p> : list(remove)}
          {keep.length && channel.mode === "add_and_remove" ? <p className="mt-2 text-xs text-muted">{keep.length} protected paused member(s) are kept.</p> : null}
        </section>
        <section aria-labelledby="pv-skip">
          <h3 id="pv-skip" className="mb-2 text-sm font-semibold text-muted">
            Skipped, no Slack account found ({skipped.length})
          </h3>
          {list(skipped)}
        </section>
      </CardBody>
    </Card>
  );
}
