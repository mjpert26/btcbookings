import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { isUuid } from "@/server/ui/form";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Notice } from "@/components/ui/Toast";
import { ActionButton } from "@/components/app/ActionButton";
import { ConfirmAction } from "@/components/app/ConfirmAction";
import { MASS_REMOVAL_APPROVAL_MINUTES } from "@/server/sync/admin";
import { MASS_REMOVAL_ALERT } from "@/server/sync/apply";
import { formatDateTime, formatRelative } from "@/lib/format";
import { linkQueueAction, requestSyncNowAction, resolveAlertAction, setSyncSettingsAction, unlinkQueueAction } from "../../../_actions/sync";
import { AddQueueForm, SyncSettingsForm } from "./SyncForms";

export const metadata: Metadata = { title: "Queue sync" };

export default async function TeamSyncPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();

  const data = await withUser(user.id, async (tx) => {
    const [team] = await tx<{ id: string; name: string; membership_source: string; removal_policy: string; mass_removal_threshold_pct: number; last_synced_at: Date | null; sync_health: string; sync_error: string | null }[]>`
      select id, name, membership_source, removal_policy, mass_removal_threshold_pct, last_synced_at, sync_health, sync_error
      from app.teams where id = ${id}
    `;
    if (!team) return null;
    const queues = await tx<{ id: string; queue_id: string; queue_name: string | null; last_snapshot_at: Date | null; created_at: Date }[]>`
      select id, queue_id, queue_name, last_snapshot_at, created_at from app.team_sf_queues where team_id = ${id} order by created_at
    `;
    const alerts = await tx<{ id: string; kind: string; detail: Record<string, unknown>; created_at: Date; resolved_at: Date | null; resolved_by_name: string | null }[]>`
      select a.id, a.kind, a.detail, a.created_at, a.resolved_at, u.name as resolved_by_name
      from app.sync_alerts a left join app.users u on u.id = a.resolved_by
      where a.team_id = ${id}
      order by a.resolved_at nulls first, a.created_at desc
      limit 20
    `;
    const [counts] = await tx<{ queue: number; manual: number }[]>`
      select count(*) filter (where source = 'queue')::int as queue, count(*) filter (where source = 'manual')::int as manual
      from app.team_members where team_id = ${id}
    `;
    return { team, queues, alerts, counts };
  });
  if (!data) notFound();
  const { team, queues, alerts, counts } = data;
  const open = alerts.filter((a) => !a.resolved_at);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/admin", label: "Admin" },
          { href: `/teams/${team.id}`, label: team.name },
        ]}
        title="Salesforce Queue sync"
        description="Link Salesforce Queues to drive this team's roster. Sync is one-way: Queue, then team status, then Slack."
        actions={
          <ActionButton action={requestSyncNowAction.bind(null, team.id)} variant="primary" pendingLabel="Requesting…">
            Sync now
          </ActionButton>
        }
      />

      {sp.created ? (
        <Notice tone="success" title="Team created" className="mb-6">
          Link the Salesforce Queues that drive this roster. Members appear after the next snapshot.
        </Notice>
      ) : null}

      {open.length ? (
        <Notice tone="warning" title={`${open.length} open sync alert${open.length === 1 ? "" : "s"}`} className="mb-6">
          A blocked sync leaves the roster unchanged until an admin reviews it.
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" aria-labelledby="queues-h">
          <CardHeader id="queues-h" title="Linked queues" description={`${counts.queue} queue members, ${counts.manual} manual members on the roster.`} />
          <CardBody className="space-y-5">
            {queues.length === 0 ? (
              <p className="text-sm text-muted">No queues linked. The roster is managed manually until you link one.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {queues.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-navy">{q.queue_id}</p>
                      <p className="text-xs text-muted">
                        {q.queue_name ?? "Unnamed queue"} · last snapshot {formatRelative(q.last_snapshot_at)}
                      </p>
                    </div>
                    <ActionButton action={unlinkQueueAction.bind(null, team.id)} hidden={{ queueId: q.queue_id }} variant="ghost" size="sm" pendingLabel="Removing…">
                      Unlink<span className="sr-only"> {q.queue_id}</span>
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
            <AddQueueForm action={linkQueueAction.bind(null, team.id)} />
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card aria-labelledby="health-h">
            <CardHeader id="health-h" title="Sync health" actions={<StatusBadge status={team.sync_health} />} />
            <CardBody className="space-y-1 text-sm">
              <p>
                Last synced: <span className="font-medium">{team.last_synced_at ? formatDateTime(team.last_synced_at, user.timezone) : "Never"}</span>
              </p>
              {team.sync_error ? <p className="text-danger">{team.sync_error}</p> : null}
              <p className="text-muted">The n8n poller sends a queue snapshot every 2 minutes.</p>
            </CardBody>
          </Card>
          <Card aria-labelledby="settings-h">
            <CardHeader id="settings-h" title="Settings" />
            <CardBody>
              <SyncSettingsForm
                action={setSyncSettingsAction.bind(null, team.id)}
                initial={{ membershipSource: team.membership_source, removalPolicy: team.removal_policy, massRemovalThresholdPct: team.mass_removal_threshold_pct }}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      <Card className="mt-6" aria-labelledby="alerts-h">
        <CardHeader id="alerts-h" title="Alerts" />
        {alerts.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No alerts for this team.</p>
        ) : (
          <Table caption="Sync alerts">
            <THead>
              <TR>
                <TH>Raised</TH>
                <TH>Kind</TH>
                <TH>Detail</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {alerts.map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(a.created_at, user.timezone)}</TD>
                  <TD>
                    <Badge tone="warning">{a.kind.replace(/_/g, " ")}</Badge>
                  </TD>
                  <TD>
                    <code className="block max-w-md whitespace-pre-wrap break-words text-xs text-muted">{JSON.stringify(a.detail)}</code>
                  </TD>
                  <TD>{a.resolved_at ? <span className="text-sm text-muted">Resolved {a.resolved_by_name ? `by ${a.resolved_by_name}` : ""}</span> : <Badge tone="danger">Open</Badge>}</TD>
                  <TD>
                    {!a.resolved_at ? (
                      <div className="flex flex-wrap items-start gap-2">
                        {a.kind === MASS_REMOVAL_ALERT ? (
                          <ConfirmAction
                            action={resolveAlertAction}
                            hidden={{ alertId: a.id, approveMassRemoval: "on" }}
                            trigger="Approve mass removal"
                            triggerSize="sm"
                            triggerVariant="primary"
                            variant="primary"
                            title="Approve the blocked removals?"
                            description={`The next queue snapshot within ${MASS_REMOVAL_APPROVAL_MINUTES} minutes is applied even though it exceeds the safety rail: members missing from the linked queues are paused${team.removal_policy === "reassign" ? " and their upcoming bookings are reassigned" : ""}. Check the queue in Salesforce first.`}
                            confirmLabel="Approve and resolve"
                          />
                        ) : null}
                        <ActionButton action={resolveAlertAction} hidden={{ alertId: a.id }} size="sm" pendingLabel="Resolving…">
                          {a.kind === MASS_REMOVAL_ALERT ? "Resolve without approving" : "Resolve"}
                        </ActionButton>
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
