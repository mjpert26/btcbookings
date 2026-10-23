import type { Metadata } from "next";
import { requireUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { mcpResource } from "@/server/oauth/config";
import { myIntegrations } from "@/server/integrations/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { ActionButton } from "@/components/app/ActionButton";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import { disconnectAppAction, revokeMyTokenAction } from "../_actions";
import { NewApiKey } from "./NewApiKey";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

function Code({ children }: { children: string }) {
  return <code className="block overflow-x-auto rounded-lg bg-surface-alt px-3 py-2 font-mono text-xs text-ink">{children}</code>;
}

export default async function IntegrationsPage() {
  const user = await requireUser();
  const { keys, apps } = await myIntegrations(user);
  const mcpUrl = mcpResource();
  const apiBase = `${env().APP_BASE_URL}/api/v1`;
  const zone = user.timezone;

  return (
    <>
      <PageHeader
        title="Integrations"
        description={`Connect AI assistants and other tools to BTC Scheduler. Everything they do acts as you, with your role (${ROLE_LABEL[user.role]}) and permissions, and is recorded in the audit log.`}
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="MCP server" description="For Claude and other assistants that support the Model Context Protocol. You sign in with Microsoft and approve the connection." />
          <CardBody className="space-y-4 text-sm">
            <div>
              <p className="font-semibold text-ink">Server URL</p>
              <Code>{mcpUrl}</Code>
            </div>
            <div>
              <p className="font-semibold text-ink">Claude (claude.ai or the desktop app)</p>
              <p className="text-muted">Settings &gt; Connectors &gt; Add custom connector, then paste the server URL.</p>
            </div>
            <div>
              <p className="font-semibold text-ink">Claude Code</p>
              <Code>{`claude mcp add --transport http btc-scheduler ${mcpUrl}`}</Code>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Connected apps" description="Apps you approved through the MCP sign-in. Disconnecting signs the app out immediately." />
          <CardBody>
            {apps.length ? (
              <Table caption="Connected apps">
                <THead>
                  <TR>
                    <TH>App</TH>
                    <TH>Connected</TH>
                    <TH>Last used</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {apps.map((a) => (
                    <TR key={a.client_id}>
                      <TD className="font-semibold">{a.name}</TD>
                      <TD>{formatDateTime(a.connected_at, zone)}</TD>
                      <TD>{a.last_used_at ? formatDateTime(a.last_used_at, zone) : "Never"}</TD>
                      <TD className="text-right">
                        <ActionButton action={disconnectAppAction} hidden={{ clientId: a.client_id }} size="sm" variant="secondary" pendingLabel="Working…">
                          Disconnect
                        </ActionButton>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No apps connected.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="API keys" description="For scripts and automations (for example n8n). Send the key as Authorization: Bearer <key>." />
          <CardBody className="space-y-6">
            <div className="text-sm">
              <p className="font-semibold text-ink">REST API base URL</p>
              <Code>{apiBase}</Code>
              <p className="mt-2 text-muted">
                OpenAPI description: <a className="text-primary underline" href="/api/v1/openapi.json">{`${apiBase}/openapi.json`}</a>
              </p>
            </div>
            <NewApiKey />
            {keys.length ? (
              <Table caption="Your API keys">
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Key</TH>
                    <TH>Created</TH>
                    <TH>Last used</TH>
                    <TH>Expires</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {keys.map((k) => (
                    <TR key={k.id}>
                      <TD className="font-semibold">{k.name}</TD>
                      <TD className="font-mono text-xs">{k.prefix}…</TD>
                      <TD>{formatDateTime(k.created_at, zone)}</TD>
                      <TD>{k.last_used_at ? formatDateTime(k.last_used_at, zone) : "Never"}</TD>
                      <TD>{k.expires_at ? formatDateTime(k.expires_at, zone) : "Never"}</TD>
                      <TD className="text-right">
                        <ActionButton action={revokeMyTokenAction} hidden={{ tokenId: k.id }} size="sm" variant="secondary" pendingLabel="Working…">
                          Revoke
                        </ActionButton>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
