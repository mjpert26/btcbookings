import type { Metadata } from "next";
import Link from "next/link";
import { requireCapability } from "@/server/auth/session";
import { loadAuditPage } from "@/server/audit-log";
import { AUDIT_VIAS } from "@/server/audit";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Select } from "@/components/ui/Field";
import { Button, ButtonLink } from "@/components/ui/Button";
import { AuditChanges } from "@/components/app/AuditChanges";
import { formatDateTime } from "@/lib/format";
import { viaLabel } from "@/lib/audit-diff";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

/** Admins and managers (read-only). The admin layout allows managers onto this page only. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireCapability("audit.read");
  const raw = await searchParams;
  const input = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (Array.isArray(v) ? v[0] : v) || undefined]));
  const zone = user.timezone;
  const { entries, nextCursor, options, filters: f } = await loadAuditPage(user, input, { timezone: zone, pageSize: PAGE_SIZE });

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, cursor: undefined, ...over })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/admin/audit?${s}` : "/admin/audit";
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description={
          user.role === "admin"
            ? "Append-only record of settings changes and booking activity, with the fields each change touched."
            : "Read-only record of settings changes and booking activity, with the fields each change touched."
        }
      />
      <form method="get" className="mb-4 grid grid-cols-1 gap-3 rounded-brand border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end" aria-label="Filter audit log">
        <Select label="Actor" name="actor" defaultValue={f.actor ?? ""} placeholder="Anyone" options={options.actors.map((a) => ({ value: a.id, label: a.name }))} />
        <Select label="Entity type" name="entityType" defaultValue={f.entityType ?? ""} placeholder="Any entity" options={options.entityTypes.map((e) => ({ value: e, label: e }))} />
        <Input label="Entity ID" name="entityId" defaultValue={f.entityId} placeholder="Exact ID" autoComplete="off" />
        <Input label="Action starts with" name="action" defaultValue={f.action} placeholder="e.g. booking. or event_type.update" list="audit-actions" autoComplete="off" />
        <datalist id="audit-actions">
          {options.actions.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <Select label="Channel" name="via" defaultValue={f.via ?? ""} placeholder="Any channel" options={AUDIT_VIAS.map((v) => ({ value: v, label: viaLabel(v) }))} />
        <Input label="From" name="from" type="date" defaultValue={f.from} />
        <Input label="To" name="to" type="date" defaultValue={f.to} />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            Apply
          </Button>
          <ButtonLink href="/admin/audit" variant="secondary">
            Reset
          </ButtonLink>
        </div>
      </form>

      {entries.length === 0 ? (
        <EmptyState title="No entries" description="Nothing matches these filters." />
      ) : (
        <Card>
          <Table caption="Audit log entries">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Who</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Channel</TH>
                <TH>Changes</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap align-top">{formatDateTime(r.at, zone)}</TD>
                  <TD className="align-top">
                    {r.actorUserId ? (
                      <Link href={qs({ actor: r.actorUserId })} className="text-primary hover:underline">
                        {r.actorLabel}
                      </Link>
                    ) : (
                      <span className="text-muted">{r.actorLabel}</span>
                    )}
                  </TD>
                  <TD className="align-top">
                    <Link href={qs({ action: r.action })}>
                      <Badge tone="primary">{r.action}</Badge>
                    </Link>
                  </TD>
                  <TD className="align-top">
                    <div>{r.entityType}</div>
                    {r.entityId ? (
                      <Link href={qs({ entityType: r.entityType, entityId: r.entityId })} className="block max-w-40 truncate font-mono text-xs text-muted hover:text-primary" title={r.entityId}>
                        {r.entityId}
                      </Link>
                    ) : null}
                    {r.entityType === "booking" && r.entityId ? (
                      <Link href={`/bookings/${r.entityId}`} className="text-xs font-medium text-primary hover:underline">
                        Open booking
                      </Link>
                    ) : null}
                  </TD>
                  <TD className="whitespace-nowrap align-top">{viaLabel(r.via)}</TD>
                  <TD className="min-w-64 align-top">
                    <AuditChanges changes={r.changes} zone={zone} empty="No details recorded." />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <nav aria-label="Pagination" className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            <span className="text-muted">
              {entries.length} entr{entries.length === 1 ? "y" : "ies"}
              {f.cursor ? " (older page)" : ""}
            </span>
            <span className="flex gap-2">
              {f.cursor ? (
                <ButtonLink href={qs({})} variant="secondary" size="sm">
                  Newest
                </ButtonLink>
              ) : null}
              {nextCursor ? (
                <ButtonLink href={qs({ cursor: nextCursor })} variant="secondary" size="sm">
                  Older
                </ButtonLink>
              ) : null}
            </span>
          </nav>
        </Card>
      )}
    </>
  );
}
