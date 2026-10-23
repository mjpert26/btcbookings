import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { env } from "@/server/env";
import { authorizationServerMetadata, mcpResource } from "@/server/oauth/config";
import { adminIntegrations } from "@/server/integrations/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { ActionButton } from "@/components/app/ActionButton";
import { ActionForm } from "@/components/ui/Form";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { formatDateTime } from "@/lib/format";
import { RequestLogTable } from "@/components/app/RequestLogTable";
import { addCallbackAction, registerClientAction, removeCallbackAction, revokeAnyTokenAction, toggleClientAction } from "../../_actions/integrations";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 py-1.5 sm:grid-cols-3">
      <dt className="text-muted">{label}</dt>
      <dd className="sm:col-span-2">
        <code className="break-all font-mono text-xs">{value}</code>
      </dd>
    </div>
  );
}

export default async function AdminIntegrationsPage() {
  const user = await requireAdmin();
  const { allowlist, clients, tokens, requests } = await adminIntegrations(user);
  const meta = authorizationServerMetadata();
  const zone = user.timezone;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="The MCP server and REST API act as the signed-in user with their role. Manage which OAuth callback URLs MCP clients may use, registered clients, and every active key."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Connection details" />
          <CardBody>
            <dl className="text-sm">
              <Row label="MCP server URL" value={mcpResource()} />
              <Row label="REST API base URL" value={`${env().APP_BASE_URL}/api/v1`} />
              <Row label="OAuth issuer" value={meta.issuer} />
              <Row label="Authorization endpoint" value={meta.authorization_endpoint} />
              <Row label="Token endpoint" value={meta.token_endpoint} />
              <Row label="Client registration" value={meta.registration_endpoint} />
            </dl>
            <p className="mt-3 text-xs text-muted">
              To serve the MCP server at mcp.bigthinkcapital.com, add that domain to the Vercel project, point a CNAME at Vercel, and set MCP_BASE_URL=https://mcp.bigthinkcapital.com.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Allowed callback URLs"
            description="MCP clients can register only these OAuth callback (redirect) URLs. Use :* in place of a port for local clients that pick a random port."
          />
          <CardBody className="space-y-4">
            <Table caption="Allowed callback URLs">
              <THead>
                <TR>
                  <TH>Callback URL</TH>
                  <TH>Note</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {allowlist.map((a) => (
                  <TR key={a.id}>
                    <TD className="font-mono text-xs">{a.pattern}</TD>
                    <TD>{a.note}</TD>
                    <TD className="text-right">
                      <ActionButton action={removeCallbackAction} hidden={{ id: a.id }} size="sm" variant="secondary" pendingLabel="Working…">
                        Remove
                      </ActionButton>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <ActionForm action={addCallbackAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex-1 text-sm">
                <span className="block font-semibold">Callback URL</span>
                <input name="pattern" required placeholder="https://example.com/oauth/callback" className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
              </label>
              <label className="text-sm sm:w-56">
                <span className="block font-semibold">Note</span>
                <input name="note" maxLength={200} placeholder="Which app uses it" className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
              </label>
              <SubmitButton pendingLabel="Adding…">Allow</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="OAuth clients" description="Clients register themselves when someone connects them, or an admin registers one here for apps without dynamic registration." />
          <CardBody className="space-y-4">
            {clients.length ? (
              <Table caption="OAuth clients">
                <THead>
                  <TR>
                    <TH>App</TH>
                    <TH>Client ID</TH>
                    <TH>Callback URLs</TH>
                    <TH>Users</TH>
                    <TH>Last used</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {clients.map((c) => (
                    <TR key={c.client_id}>
                      <TD>
                        <span className="font-semibold">{c.name}</span>
                        {c.disabled_at ? <Badge className="ml-2">Disabled</Badge> : null}
                        <div className="text-xs text-muted">{c.registered_via === "admin" ? "Registered by an admin" : "Self-registered"}</div>
                      </TD>
                      <TD className="font-mono text-xs">{c.client_id}</TD>
                      <TD className="font-mono text-xs">{c.redirect_uris.join(", ")}</TD>
                      <TD>{c.users}</TD>
                      <TD>{c.last_used_at ? formatDateTime(c.last_used_at, zone) : "Never"}</TD>
                      <TD className="text-right">
                        <ActionButton action={toggleClientAction} hidden={{ clientId: c.client_id, disable: c.disabled_at ? "0" : "1" }} size="sm" variant="secondary" pendingLabel="Working…">
                          {c.disabled_at ? "Enable" : "Disable"}
                        </ActionButton>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No clients yet.</p>
            )}
            <ActionForm action={registerClientAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="text-sm sm:w-56">
                <span className="block font-semibold">App name</span>
                <input name="name" required maxLength={100} className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
              </label>
              <label className="flex-1 text-sm">
                <span className="block font-semibold">Callback URLs (comma or space separated)</span>
                <input name="callbacks" required className="mt-1 h-10 w-full rounded-lg border border-border px-3" />
              </label>
              <SubmitButton pendingLabel="Registering…">Register client</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Active keys and connections" description="Every API key and app connection that can currently act on someone's behalf." />
          <CardBody>
            {tokens.length ? (
              <Table caption="Active keys and connections">
                <THead>
                  <TR>
                    <TH>User</TH>
                    <TH>Type</TH>
                    <TH>Name or app</TH>
                    <TH>Last used</TH>
                    <TH>Expires</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {tokens.map((t) => (
                    <TR key={t.id}>
                      <TD>{t.user_name}</TD>
                      <TD>{t.kind === "api_key" ? "API key" : "App connection"}</TD>
                      <TD>
                        {t.kind === "api_key" ? t.name : t.client_name} <span className="font-mono text-xs text-muted">{t.prefix}…</span>
                      </TD>
                      <TD>{t.last_used_at ? formatDateTime(t.last_used_at, zone) : "Never"}</TD>
                      <TD>{t.expires_at ? formatDateTime(t.expires_at, zone) : "Never"}</TD>
                      <TD className="text-right">
                        <ActionButton action={revokeAnyTokenAction} hidden={{ tokenId: t.id }} size="sm" variant="secondary" pendingLabel="Working…">
                          Revoke
                        </ActionButton>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No active keys or connections.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent requests" description="The last 100 REST API and MCP requests from signed-in callers. Bodies are never stored; entries are kept for 30 days." />
          <CardBody>
            <RequestLogTable rows={requests} zone={zone} showUser caption="Recent API and MCP requests" />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
