import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { loadSyncStatus } from "@/server/sync/status";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelative } from "@/lib/format";
import { ErrorList, RunSummary, SlackJobsSummary } from "./StatusParts";

export const metadata: Metadata = { title: "Sync status" };

/**
 * Sync status overview (BTCSCHED-51): for every team with a Salesforce Queue or Slack link,
 * the last queue sync and its result, roster changes, Slack job backlog and current errors.
 */
export default async function SyncStatusPage() {
  const user = await requireAdmin();
  const { teams, unlinkedTeams } = await withUser(user.id, (tx) => loadSyncStatus(tx));

  return (
    <>
      <PageHeader
        title="Sync status"
        description="Salesforce Queue to booking pages to Slack. A rep removed from a partner's queue is paused on the team, stops being offered on its booking pages, and is removed from the partner's Slack channels and user group."
      />
      {unlinkedTeams ? (
        <p className="mb-4 text-sm text-muted">
          {unlinkedTeams} team{unlinkedTeams === 1 ? " has" : "s have"} no Salesforce Queue or Slack link. No sync or Slack work runs for {unlinkedTeams === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {teams.length === 0 ? (
        <EmptyState title="No linked teams" description="Link a Salesforce Queue or a Slack channel to a team to see its sync status here." />
      ) : (
        <Card aria-labelledby="sync-h">
          <CardHeader id="sync-h" title="Teams" />
          <Table caption="Sync status per team">
            <THead>
              <TR>
                <TH>Team</TH>
                <TH>Queue sync</TH>
                <TH>Last run</TH>
                <TH>Last roster change</TH>
                <TH>Slack jobs</TH>
                <TH>Errors</TH>
              </TR>
            </THead>
            <TBody>
              {teams.map((t) => (
                <TR key={t.teamId}>
                  <TD>
                    <Link href={`/admin/teams/${t.teamId}/sync`} className="font-semibold text-primary hover:underline">
                      {t.name}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted">
                      <span>{t.queues} queue{t.queues === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <Link href={`/admin/teams/${t.teamId}/slack`} className="hover:underline">
                        {t.slackChannels} channel{t.slackChannels === 1 ? "" : "s"}
                        {t.slackUsergroup ? `, user group${t.slackUsergroup.dryRun ? " (dry run)" : ""}` : ""}
                      </Link>
                    </div>
                    {t.openAlerts ? (
                      <Badge tone="warning" className="mt-1">
                        {t.openAlerts} open alert{t.openAlerts === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </TD>
                  <TD>
                    {t.queues === 0 ? (
                      <span className="text-sm text-muted">No queue linked</span>
                    ) : (
                      <div className="space-y-1 text-sm">
                        <StatusBadge status={t.syncHealth} />
                        <p className="text-muted">Synced {formatRelative(t.lastSyncedAt)}</p>
                      </div>
                    )}
                  </TD>
                  <TD>{t.queues === 0 ? <span className="text-sm text-muted">n/a</span> : <RunSummary run={t.lastRun} />}</TD>
                  <TD>{t.queues === 0 ? <span className="text-sm text-muted">n/a</span> : <RunSummary run={t.lastChangeRun} empty="None yet" />}</TD>
                  <TD>
                    <SlackJobsSummary status={t} />
                  </TD>
                  <TD>
                    <ErrorList errors={t.errors} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
