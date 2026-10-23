import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import StatCard from "@/components/reactbits/StatCard";
import { ButtonLink } from "@/components/ui/Button";
import { loadAdminCounts } from "@/server/ui/overview";
import { formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const user = await requireAdmin();
  const data = await withUser(user.id, async (tx) => {
    const c = await loadAdminCounts(tx);
    const teams = await tx<{ id: string; name: string; membership_source: string; last_synced_at: Date | null; sync_health: string; queues: number; channels: number; open_alerts: number; members: number }[]>`
      select t.id, t.name, t.membership_source, t.last_synced_at, t.sync_health,
             (select count(*)::int from app.team_sf_queues q where q.team_id = t.id) as queues,
             (select count(*)::int from app.team_slack_channels s where s.team_id = t.id) as channels,
             (select count(*)::int from app.sync_alerts a where a.team_id = t.id and a.resolved_at is null) as open_alerts,
             (select count(*)::int from app.team_members m where m.team_id = t.id and m.status = 'active') as members
      from app.teams t order by t.name
    `;
    const broken = await tx<{ id: string; name: string; email: string; status: string; since: Date | null; last_error: string | null }[]>`
      select u.id, u.name, u.email, cc.status, coalesce(cc.broken_at, cc.updated_at) as since, cc.last_error
      from app.calendar_connections cc join app.users u on u.id = cc.user_id and u.is_active
      where cc.status in ('broken', 'disconnected')
      order by (cc.status = 'broken') desc, since desc nulls last
      limit 20
    `;
    return { c, teams, broken };
  });
  const { c } = data;

  return (
    <>
      <PageHeader title="Admin" description="Health of integrations and team syncs." />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard index={0} label="Open sync alerts" value={c.openSyncAlerts} tone={c.openSyncAlerts ? "warning" : "default"} hint="Queue sync safety rail and staleness" />
        <StatCard
          index={1}
          label="Dead Salesforce lead jobs"
          value={c.deadSfLeadJobs}
          tone={c.deadSfLeadJobs ? "warning" : "default"}
          href="/admin/salesforce/jobs?status=dead"
          hint={c.failedSfLeadJobs ? `Need a manual retry. ${c.failedSfLeadJobs} more failed and retrying.` : "Need a manual retry"}
        />
        <StatCard index={2} label="Slack channel issues" value={c.slackChannelIssues} tone={c.slackChannelIssues ? "warning" : "default"} hint="Health not ok: unchecked, bot missing or errors" />
        <StatCard index={3} label="Broken Outlook connections" value={c.brokenOutlookConnections} tone={c.brokenOutlookConnections ? "warning" : "default"} hint="Revoked or expired; users must reconnect" />
      </div>

      <Card className="mt-6" aria-labelledby="teams-h">
        <CardHeader id="teams-h" title="Teams" description="Queue sync and Slack configuration per team." actions={<ButtonLink href="/admin/teams/new" variant="secondary" size="sm">New team</ButtonLink>} />
        <Table caption="Teams and sync status">
          <THead>
            <TR>
              <TH>Team</TH>
              <TH>Roster source</TH>
              <TH>Sync health</TH>
              <TH>Last synced</TH>
              <TH className="text-right">Active</TH>
              <TH>Configure</TH>
            </TR>
          </THead>
          <TBody>
            {data.teams.map((t) => (
              <TR key={t.id}>
                <TD>
                  <Link href={`/teams/${t.id}`} className="font-semibold text-primary hover:underline">
                    {t.name}
                  </Link>
                  {t.open_alerts ? (
                    <Badge tone="warning" className="ml-2">
                      {t.open_alerts} alert{t.open_alerts === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                </TD>
                <TD>{t.membership_source.replace(/_/g, " ")}</TD>
                <TD>
                  <StatusBadge status={t.sync_health} />
                </TD>
                <TD>{t.membership_source === "manual" ? <span className="text-muted">n/a</span> : formatRelative(t.last_synced_at)}</TD>
                <TD className="text-right tabular-nums">{t.members}</TD>
                <TD>
                  <span className="flex gap-3">
                    <Link href={`/admin/teams/${t.id}/sync`} className="font-medium text-primary hover:underline">
                      Queues ({t.queues})
                    </Link>
                    <Link href={`/admin/teams/${t.id}/slack`} className="font-medium text-primary hover:underline">
                      Slack ({t.channels})
                    </Link>
                  </span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card className="mt-6" aria-labelledby="broken-h">
        <CardHeader id="broken-h" title="Outlook connections needing attention" description="Broken (revoked or expired) and disconnected calendars. These users are skipped by round-robin and new bookings cannot be written to their calendars." />
        {data.broken.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">All connected calendars are healthy.</p>
        ) : (
          <Table caption="Broken Outlook connections">
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Status</TH>
                <TH>Since</TH>
              </TR>
            </THead>
            <TBody>
              {data.broken.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <div className="font-medium text-navy">{b.name}</div>
                    <div className="text-xs text-muted">{b.email}</div>
                  </TD>
                  <TD>
                    <StatusBadge status={b.status} />
                  </TD>
                  <TD>
                    {formatRelative(b.since)}
                    {b.status === "broken" && b.last_error ? <p className="mt-1 max-w-sm break-words text-xs text-muted">{b.last_error}</p> : null}
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
