import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { listSfLeadJobs, type SfLeadJobView } from "@/server/salesforce/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Field";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ActionButton } from "@/components/app/ActionButton";
import { formatDateTime } from "@/lib/format";
import { retrySfJobAction } from "../../_actions/salesforce";

export const metadata: Metadata = { title: "Salesforce lead jobs" };

const STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

const filters = z.object({
  status: z.enum([...STATUSES, "problem"]).optional().catch(undefined),
  eventType: z.string().uuid().optional().catch(undefined),
});

const PAGE_LIMIT = 200;

export default async function SfJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAdmin();
  const f = filters.parse(await searchParams);

  const jobs = await listSfLeadJobs(user, {
    status: f.status === "problem" ? ["failed", "dead"] : f.status ? [f.status] : undefined,
    eventTypeId: f.eventType,
    limit: PAGE_LIMIT,
  });

  // Display names for the listed jobs (the outbox view carries ids only).
  const bookingIds = [...new Set(jobs.map((j) => j.bookingId).filter((v): v is string => Boolean(v)))];
  const eventTypeIds = [...new Set(jobs.map((j) => j.eventTypeId).filter((v): v is string => Boolean(v)))];
  const names = await withUser(user.id, async (tx) => {
    const invitees = bookingIds.length
      ? await tx<{ id: string; invitee_name: string }[]>`select id, invitee_name from app.bookings where id = any(${bookingIds}::uuid[])`
      : [];
    const types = eventTypeIds.length
      ? await tx<{ id: string; name: string; language: string }[]>`select id, name, language from app.event_types where id = any(${eventTypeIds}::uuid[])`
      : [];
    return {
      invitee: new Map(invitees.map((b) => [b.id, b.invitee_name])),
      eventType: new Map(types.map((t) => [t.id, `${t.name} (${t.language.toUpperCase()})`])),
    };
  });

  return (
    <>
      <PageHeader title="Salesforce lead jobs" description="Every booking with lead creation on queues one job. Jobs retry with backoff; dead jobs need a manual retry." />
      <form method="get" className="mb-4 flex flex-col gap-3 rounded-brand border border-border bg-surface p-4 sm:flex-row sm:items-end" aria-label="Filter jobs">
        {f.eventType ? <input type="hidden" name="eventType" value={f.eventType} /> : null}
        <Select
          label="Status"
          name="status"
          defaultValue={f.status ?? ""}
          placeholder="All statuses"
          options={[
            { value: "problem", label: "Failed or dead" },
            { value: "pending", label: "Pending" },
            { value: "running", label: "Running" },
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed (retrying)" },
            { value: "dead", label: "Dead" },
          ]}
          wrapperClassName="sm:w-64"
        />
        <Button type="submit">Apply</Button>
        {f.status || f.eventType ? (
          <ButtonLink href="/admin/salesforce/jobs" variant="secondary">
            Clear filters
          </ButtonLink>
        ) : null}
      </form>

      {jobs.length === 0 ? (
        <EmptyState title="No lead jobs" description="Jobs appear when bookings are made on event types with lead creation turned on." />
      ) : (
        <Card>
          <Table caption="Salesforce lead jobs">
            <THead>
              <TR>
                <TH>Created</TH>
                <TH>Booking</TH>
                <TH>Status</TH>
                <TH className="text-right">Attempts</TH>
                <TH>Lead</TH>
                <TH>Last error and history</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} zone={user.timezone} invitee={j.bookingId ? names.invitee.get(j.bookingId) : undefined} eventType={j.eventTypeId ? names.eventType.get(j.eventTypeId) : undefined} />
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {jobs.length === PAGE_LIMIT ? <p className="mt-3 text-sm text-muted">Showing the newest {PAGE_LIMIT} jobs. Filter by status to narrow the list.</p> : null}
    </>
  );
}

function JobRow({ job: j, zone, invitee, eventType }: { job: SfLeadJobView; zone: string; invitee?: string; eventType?: string }) {
  return (
    <TR>
      <TD className="whitespace-nowrap">{formatDateTime(new Date(j.createdAt), zone)}</TD>
      <TD>
        {j.bookingId ? (
          <Link href={`/bookings/${j.bookingId}`} className="font-medium text-primary hover:underline">
            {invitee ?? "Booking"}
          </Link>
        ) : (
          "—"
        )}
        {eventType ? <div className="text-xs text-muted">{eventType}</div> : null}
      </TD>
      <TD>
        <StatusBadge status={j.status} />
        {j.status === "pending" || j.status === "failed" ? <div className="mt-1 text-xs text-muted">Next run {formatDateTime(new Date(j.runAt), zone)}</div> : null}
      </TD>
      <TD className="text-right tabular-nums">
        {j.attempts}/{j.maxAttempts}
      </TD>
      <TD>
        {j.sfLeadStatus ? <StatusBadge status={j.sfLeadStatus} /> : null}
        {j.sfLeadId ? <div className="mt-1 font-mono text-xs text-muted">{j.sfLeadId}</div> : null}
      </TD>
      <TD className="max-w-sm">
        {j.lastError ? <p className="break-words text-xs text-danger">{j.lastError}</p> : <span className="text-muted">—</span>}
        {j.attemptLog.length ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-semibold text-primary">
              {j.attemptLog.length} attempt{j.attemptLog.length === 1 ? "" : "s"}
            </summary>
            <ol className="mt-2 space-y-1.5 text-xs">
              {j.attemptLog.map((a) => (
                <li key={`${a.attemptNo}-${a.createdAt}`} className="rounded-md bg-surface-alt px-2 py-1.5">
                  <span className="font-semibold text-navy">#{a.attemptNo}</span> {formatDateTime(new Date(a.createdAt), zone)}
                  {a.responseCode !== null ? <span className="ml-1 font-mono">HTTP {a.responseCode}</span> : null}
                  {a.durationMs !== null ? <span className="ml-1 text-muted">{a.durationMs} ms</span> : null}
                  {a.error ? <p className="mt-0.5 break-words text-danger">{a.error}</p> : <p className="mt-0.5 text-success">OK</p>}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </TD>
      <TD>
        {j.status === "failed" || j.status === "dead" ? (
          <ActionButton action={retrySfJobAction} hidden={{ jobId: j.id }} size="sm" pendingLabel="Retrying…">
            Retry
          </ActionButton>
        ) : j.status === "succeeded" ? (
          <Badge tone="success">Done</Badge>
        ) : null}
      </TD>
    </TR>
  );
}
