import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { listImportedPages, type ImportedPagesRow } from "@/server/import/calendly/cutover";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { ActionButton } from "@/components/app/ActionButton";
import { goLiveImportedAction, pauseImportedAction } from "../../_actions/import";
import { ImportForm } from "./ImportForm";
import { GoLiveAll } from "./GoLiveAll";

export const metadata: Metadata = { title: "Import from Calendly" };
// Large snapshots run several thousand statements in one transaction.
export const maxDuration = 300;

function Rows({ rows, kind }: { rows: ImportedPagesRow[]; kind: "team" | "user" }) {
  return (
    <Table caption={kind === "team" ? "Imported team pages" : "Imported personal pages"}>
      <THead>
        <TR>
          <TH>{kind === "team" ? "Team" : "Rep"}</TH>
          <TH>Outlook connected</TH>
          <TH>Live</TH>
          <TH>Ready to go live</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id}>
            <TD>
              <span className="font-semibold text-navy">{r.name}</span>{" "}
              <span className="text-xs text-muted">{kind === "team" ? `/t/${r.slug}` : `/${r.slug}`}</span>
            </TD>
            <TD>
              {kind === "team" ? (
                <Badge tone={r.connected === 0 ? "warning" : r.connected < r.hosts ? "neutral" : "success"}>
                  {r.connected} of {r.hosts}
                </Badge>
              ) : r.connected ? (
                <Badge tone="success">Yes</Badge>
              ) : (
                <Badge>Not signed in</Badge>
              )}
            </TD>
            <TD>{r.live}</TD>
            <TD>
              {r.ready}
              {r.needsHosts ? (
                <Badge tone="warning" className="ml-2" title="Assign hosts on the page before it can go live.">
                  {r.needsHosts} need{r.needsHosts === 1 ? "s" : ""} hosts
                </Badge>
              ) : null}
            </TD>
            <TD className="text-right">
              <div className="flex justify-end gap-2">
                {r.ready ? (
                  <ActionButton action={goLiveImportedAction} hidden={{ kind, id: r.id }} size="sm" variant="primary" pendingLabel="Working…">
                    Go live
                  </ActionButton>
                ) : null}
                {r.live ? (
                  <ActionButton action={pauseImportedAction} hidden={{ kind, id: r.id }} size="sm" pendingLabel="Working…">
                    Pause
                  </ActionButton>
                ) : null}
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function ImportPage() {
  const user = await requireAdmin();
  const rows = await listImportedPages(user);
  const teams = rows.filter((r) => r.kind === "team");
  const reps = rows.filter((r) => r.kind === "user");
  const ready = rows.reduce((n, r) => n + r.ready, 0);
  const live = rows.reduce((n, r) => n + r.live, 0);
  const readyWithoutOutlook = rows.reduce((n, r) => n + (r.connected === 0 ? r.ready : 0), 0);

  return (
    <>
      <PageHeader
        title="Import from Calendly"
        description="Copies Calendly members and their working hours, team pages, booking pages and upcoming meetings. Nothing is changed in Calendly and nobody is notified: imported meetings never send emails, write to Outlook or create Salesforce leads. Imported pages start inactive. Re-running the import is safe."
      />
      <Card className="mb-6">
        <CardBody>
          <ImportForm />
        </CardBody>
      </Card>

      {rows.length ? (
        <Card>
          <CardHeader
            title="Imported booking pages"
            description="Take pages live once their reps have signed in and connected Outlook; reps without a connection are never offered times. Only pages that were active in Calendly go live. Old Calendly links keep working until you retire them."
          />
          <CardBody className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="success">{live} live</Badge>
              <Badge tone="navy">{ready} ready to go live</Badge>
              {ready ? <GoLiveAll ready={ready} notConnected={readyWithoutOutlook} /> : null}
              {live ? (
                <ActionButton action={pauseImportedAction} hidden={{ kind: "all" }} size="sm" pendingLabel="Working…">
                  Pause everything
                </ActionButton>
              ) : null}
            </div>
            {teams.length ? <Rows rows={teams} kind="team" /> : null}
            {reps.length ? <Rows rows={reps} kind="user" /> : null}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
