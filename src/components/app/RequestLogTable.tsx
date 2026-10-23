import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";
import type { RequestLogRow } from "@/server/integrations/admin";

function statusTone(status: number): BadgeTone {
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  return "success";
}

/** Recent REST API and MCP requests. Shows the caller column only when `showUser` is set. */
export function RequestLogTable({ rows, zone, showUser = false, caption }: { rows: RequestLogRow[]; zone: string; showUser?: boolean; caption: string }) {
  if (!rows.length) return <p className="text-sm text-muted">No requests yet.</p>;
  return (
    <Table caption={caption}>
      <THead>
        <TR>
          <TH>Time</TH>
          {showUser ? <TH>User</TH> : null}
          <TH>Key or app</TH>
          <TH>Request</TH>
          <TH>Status</TH>
          <TH className="text-right">Duration</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id}>
            <TD className="whitespace-nowrap">{formatDateTime(r.created_at, zone)}</TD>
            {showUser ? <TD>{r.user_name ?? "Deleted user"}</TD> : null}
            <TD>
              <Badge tone={r.via === "mcp" ? "primary" : "neutral"}>{r.via === "mcp" ? "MCP" : "API"}</Badge>{" "}
              {r.via === "mcp" ? (r.client_name ?? r.key_name ?? "API key") : (r.key_name ?? "Revoked key")}
            </TD>
            <TD>
              <code className="font-mono text-xs">
                {r.method} {r.route}
              </code>
              {r.rpc_methods.length ? <span className="block text-xs text-muted">{r.rpc_methods.join(", ")}</span> : null}
            </TD>
            <TD>
              <Badge tone={statusTone(r.status)}>{r.status}</Badge>
            </TD>
            <TD className="text-right tabular-nums">{r.duration_ms} ms</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
