import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
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

const filters = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed", "dead", "problem"]).optional().catch(undefined),
  eventType: z.string().uuid().optional().catch(undefined),
});

type Job = {
  id: string;
  booking_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  sf_lead_id: string | null;
  sf_lead_status: string | null;
  event_type_id: string | null;
  event_type_name: string | null;
  invitee_name: string | null;
};

export default async function SfJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAdmin();
  const f = filters.parse(await searchParams);

  const jobs = await withUser(user.id, (tx) => tx<Job[]>`
    select j.id, j.booking_id, j.status, j.attempts, j.max_attempts, j.run_at, j.last_error, j.created_at, j.updated_at,
           j.sf_lead_id, j.sf_lead_status, j.event_type_id, et.name as event_type_name, b.invitee_name
    from app.sf_lead_jobs j
    left join app.event_types et on et.id = j.event_type_id
    left join app.bookings b on b.id = j.booking_id
    where true
      ${f.status === "problem" ? tx`and j.status in ('failed', 'dead')` : f.status ? tx`and j.status = ${f.status}` : tx``}
      ${f.eventType ? tx`and j.event_type_id = ${f.eventType}` : tx``}
    order by j.created_at desc
    limit 200
  `);

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
                <TH>Last error</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {jobs.map((j) => (
                <TR key={j.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(j.created_at, user.timezone)}</TD>
                  <TD>
                    {j.booking_id ? (
                      <Link href={`/bookings/${j.booking_id}`} className="font-medium text-primary hover:underline">
                        {j.invitee_name ?? "Booking"}
                      </Link>
                    ) : (
                      "—"
                    )}
                    {j.event_type_name ? <div className="text-xs text-muted">{j.event_type_name}</div> : null}
                  </TD>
                  <TD>
                    <StatusBadge status={j.status} />
                    {j.status === "pending" || j.status === "failed" ? <div className="mt-1 text-xs text-muted">Next run {formatDateTime(j.run_at, user.timezone)}</div> : null}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {j.attempts}/{j.max_attempts}
                  </TD>
                  <TD>
                    {j.sf_lead_status ? <StatusBadge status={j.sf_lead_status} /> : null}
                    {j.sf_lead_id ? <div className="mt-1 font-mono text-xs text-muted">{j.sf_lead_id}</div> : null}
                  </TD>
                  <TD className="max-w-xs">
                    {j.last_error ? <p className="break-words text-xs text-danger">{j.last_error}</p> : <span className="text-muted">—</span>}
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
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
