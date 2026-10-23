import type { Metadata } from "next";
import { z } from "zod";
import { requireCapability } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { countUnresolvedErrors, ERROR_STATUSES, listErrors } from "@/server/errors/admin";
import { ERROR_SOURCES } from "@/server/errors/sanitize";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Field";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ActionButton } from "@/components/app/ActionButton";
import { formatDateTime, formatRelative } from "@/lib/format";
import { setErrorResolvedAction } from "./_actions";

export const metadata: Metadata = { title: "Errors" };

const PAGE = 50;
const filters = z.object({
  source: z.enum(ERROR_SOURCES).optional().catch(undefined),
  status: z.enum(ERROR_STATUSES).catch("unresolved"),
  page: z.coerce.number().int().min(1).max(500).catch(1),
});

const SOURCE_LABEL: Record<(typeof ERROR_SOURCES)[number], string> = {
  page: "Page",
  route: "Route handler",
  action: "Server action",
  api: "REST API",
  mcp: "MCP",
  job: "Job",
  cron: "Cron",
  client: "Browser",
};

const SOURCE_TONE: Partial<Record<(typeof ERROR_SOURCES)[number], BadgeTone>> = { job: "warning", cron: "warning", api: "primary", mcp: "primary" };

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireCapability("errors.read");
  const raw = await searchParams;
  const f = filters.parse({ source: raw.source || undefined, status: raw.status || undefined, page: raw.page || undefined });
  const zone = user.timezone;

  const { rows, unresolved } = await withUser(user.id, async (tx) => ({
    rows: await listErrors(tx, { source: f.source, status: f.status, limit: PAGE + 1, offset: (f.page - 1) * PAGE }),
    unresolved: await countUnresolvedErrors(tx),
  }));
  const hasMore = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);
  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (f.source) p.set("source", f.source);
    p.set("status", f.status);
    p.set("page", String(page));
    return `/admin/errors?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Errors"
        description={`Server errors grouped by cause. Messages are redacted before they are stored. ${unresolved} unresolved.`}
      />
      <form method="get" className="mb-4 grid grid-cols-1 gap-3 rounded-brand border border-border bg-surface p-4 sm:grid-cols-3 sm:items-end" aria-label="Filter errors">
        <Select label="Source" name="source" defaultValue={f.source ?? ""} placeholder="Any source" options={ERROR_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))} />
        <Select
          label="Status"
          name="status"
          defaultValue={f.status}
          options={[
            { value: "unresolved", label: "Unresolved" },
            { value: "resolved", label: "Resolved" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            Apply
          </Button>
          <ButtonLink href="/admin/errors" variant="secondary">
            Reset
          </ButtonLink>
        </div>
      </form>

      {shown.length === 0 ? (
        <EmptyState title="No errors" description={f.status === "unresolved" ? "Nothing needs attention." : "Nothing matches these filters."} />
      ) : (
        <Card>
          <Table caption="Error log entries">
            <THead>
              <TR>
                <TH>Source</TH>
                <TH>Error</TH>
                <TH>Count</TH>
                <TH>First seen</TH>
                <TH>Last seen</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Badge tone={SOURCE_TONE[r.source] ?? "neutral"}>{SOURCE_LABEL[r.source]}</Badge>
                    {r.resolved_at ? (
                      <div className="mt-1">
                        <Badge tone="success" title={formatDateTime(r.resolved_at, zone)}>
                          Resolved{r.resolved_by_name ? ` by ${r.resolved_by_name}` : ""}
                        </Badge>
                      </div>
                    ) : null}
                  </TD>
                  <TD className="max-w-xl">
                    <div className="font-mono text-xs text-muted">
                      {r.method ? `${r.method} ` : ""}
                      {r.route ?? "—"}
                    </div>
                    <div className="break-words font-medium text-navy">
                      {r.error_name}: {r.message}
                    </div>
                    {r.stack || r.digest || Object.keys(r.context ?? {}).length ? (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-muted">Details</summary>
                        {r.digest ? <div className="mt-1 font-mono">Digest: {r.digest}</div> : null}
                        {Object.keys(r.context ?? {}).length ? (
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-alt p-2 font-mono text-[11px] leading-snug text-ink">{JSON.stringify(r.context, null, 1)}</pre>
                        ) : null}
                        {r.stack ? (
                          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre rounded bg-surface-alt p-2 font-mono text-[11px] leading-snug text-ink">{r.stack}</pre>
                        ) : null}
                      </details>
                    ) : null}
                  </TD>
                  <TD className="tabular-nums">{r.occurrences.toLocaleString("en-US")}</TD>
                  <TD className="whitespace-nowrap" title={formatDateTime(r.first_seen_at, zone)}>
                    {formatRelative(r.first_seen_at)}
                  </TD>
                  <TD className="whitespace-nowrap" title={formatDateTime(r.last_seen_at, zone)}>
                    {formatRelative(r.last_seen_at)}
                  </TD>
                  <TD>
                    {r.resolved_at ? (
                      <ActionButton action={setErrorResolvedAction} hidden={{ id: r.id, resolved: "false" }} size="sm" variant="subtle" pendingLabel="Saving…">
                        Reopen<span className="sr-only"> {r.error_name}</span>
                      </ActionButton>
                    ) : (
                      <ActionButton action={setErrorResolvedAction} hidden={{ id: r.id, resolved: "true" }} size="sm" pendingLabel="Saving…">
                        Resolve<span className="sr-only"> {r.error_name}</span>
                      </ActionButton>
                    )}
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
      <p className="mt-3 text-xs text-muted">Resolved entries are deleted 90 days after they are resolved; all entries are deleted 180 days after they were last seen.</p>
    </>
  );
}
