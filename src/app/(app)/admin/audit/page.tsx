import type { Metadata } from "next";
import { DateTime } from "luxon";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Select } from "@/components/ui/Field";
import { Button, ButtonLink } from "@/components/ui/Button";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Audit log" };

const PAGE = 100;
const filters = z.object({
  action: z.string().max(80).regex(/^[a-z0-9_.]*$/).optional().catch(undefined),
  entityType: z.string().max(60).regex(/^[a-z0-9_]*$/).optional().catch(undefined),
  actor: z.string().uuid().optional().catch(undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(500).catch(1),
});

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  return <pre className="max-h-40 max-w-sm overflow-auto whitespace-pre-wrap break-words rounded bg-surface-alt p-2 font-mono text-[11px] leading-snug text-ink">{JSON.stringify(value, null, 1)}</pre>;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAdmin();
  const raw = await searchParams;
  const f = filters.parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v || undefined])));
  const zone = user.timezone;
  const fromAt = f.from ? DateTime.fromISO(f.from, { zone }).startOf("day").toJSDate() : null;
  const toAt = f.to ? DateTime.fromISO(f.to, { zone }).plus({ days: 1 }).startOf("day").toJSDate() : null;

  const { rows, actions, entityTypes, actors } = await withUser(user.id, async (tx) => {
    const rows = await tx<{ id: string; actor: string | null; action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown; created_at: Date }[]>`
      select a.id, u.name as actor, a.action, a.entity_type, a.entity_id, a.before, a.after, a.created_at
      from app.audit_log a left join app.users u on u.id = a.actor_user_id
      where true
        ${f.action ? tx`and a.action = ${f.action}` : tx``}
        ${f.entityType ? tx`and a.entity_type = ${f.entityType}` : tx``}
        ${f.actor ? tx`and a.actor_user_id = ${f.actor}` : tx``}
        ${fromAt ? tx`and a.created_at >= ${fromAt}` : tx``}
        ${toAt ? tx`and a.created_at < ${toAt}` : tx``}
      order by a.created_at desc
      limit ${PAGE + 1} offset ${(f.page - 1) * PAGE}
    `;
    const actions = await tx<{ action: string }[]>`select distinct action from app.audit_log order by action`;
    const entityTypes = await tx<{ entity_type: string }[]>`select distinct entity_type from app.audit_log order by entity_type`;
    const actors = await tx<{ id: string; name: string }[]>`
      select distinct u.id, u.name from app.audit_log a join app.users u on u.id = a.actor_user_id order by u.name
    `;
    return { rows, actions, entityTypes, actors };
  });
  const hasMore = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, page: String(page) })) if (v) p.set(k, String(v));
    return `/admin/audit?${p.toString()}`;
  };

  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of admin and configuration changes." />
      <form method="get" className="mb-4 grid grid-cols-1 gap-3 rounded-brand border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label="Filter audit log">
        <Select label="Action" name="action" defaultValue={f.action ?? ""} placeholder="Any action" options={actions.map((a) => ({ value: a.action, label: a.action }))} />
        <Select label="Entity" name="entityType" defaultValue={f.entityType ?? ""} placeholder="Any entity" options={entityTypes.map((e) => ({ value: e.entity_type, label: e.entity_type }))} />
        <Select label="Actor" name="actor" defaultValue={f.actor ?? ""} placeholder="Anyone" options={actors.map((a) => ({ value: a.id, label: a.name }))} />
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

      {shown.length === 0 ? (
        <EmptyState title="No entries" description="Nothing matches these filters." />
      ) : (
        <Card>
          <Table caption="Audit log entries">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Before</TH>
                <TH>After</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(r.created_at, zone)}</TD>
                  <TD>{r.actor ?? <span className="text-muted">System</span>}</TD>
                  <TD>
                    <Badge tone="primary">{r.action}</Badge>
                  </TD>
                  <TD>
                    <div>{r.entity_type}</div>
                    {r.entity_id ? <div className="max-w-40 truncate font-mono text-xs text-muted" title={r.entity_id}>{r.entity_id}</div> : null}
                  </TD>
                  <TD>
                    <Json value={r.before} />
                  </TD>
                  <TD>
                    <Json value={r.after} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <nav aria-label="Pagination" className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            <span className="text-muted">Page {f.page}</span>
            <span className="flex gap-2">
              {f.page > 1 ? (
                <ButtonLink href={qs(f.page - 1)} variant="secondary" size="sm">
                  Newer
                </ButtonLink>
              ) : null}
              {hasMore ? (
                <ButtonLink href={qs(f.page + 1)} variant="secondary" size="sm">
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
