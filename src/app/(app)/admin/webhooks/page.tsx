import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { listWebhooks } from "@/server/webhooks/admin";
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS } from "@/server/webhooks/payload";
import { SIGNATURE_HEADER } from "@/server/webhooks/sign";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { ActionButton } from "@/components/app/ActionButton";
import { ConfirmAction } from "@/components/app/ConfirmAction";
import { formatDateTime } from "@/lib/format";
import { deleteWebhookAction, testWebhookAction, toggleWebhookAction } from "../_actions/webhooks";
import { NewWebhookForm, RotateSecretButton } from "./SecretForms";

export const metadata: Metadata = { title: "Webhooks" };
export const dynamic = "force-dynamic";

const DELIVERY_TONE: Record<string, BadgeTone> = { succeeded: "success", pending: "warning", failed: "danger" };

export default async function AdminWebhooksPage() {
  const user = await requireAdmin();
  const { endpoints, deliveries, teams } = await listWebhooks(user);
  const zone = user.timezone;
  const events = WEBHOOK_EVENTS.map((e) => ({ value: e, label: WEBHOOK_EVENT_LABELS[e] }));

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Send booking events to other systems, such as n8n or a partner's CRM. Each delivery is a signed HTTPS POST, retried with backoff when the receiver fails."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Add a webhook" description="HTTPS only. Private and internal addresses are refused. The signing secret is shown once." />
          <CardBody>
            <NewWebhookForm events={events} teams={teams} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Endpoints"
            description={`Verify each delivery: ${SIGNATURE_HEADER} is "t=<unix seconds>,v1=<hex HMAC-SHA256 of t + '.' + raw body, keyed by the secret>". Reject timestamps older than five minutes.`}
          />
          <CardBody>
            {endpoints.length ? (
              <Table caption="Webhook endpoints">
                <THead>
                  <TR>
                    <TH>URL</TH>
                    <TH>Events</TH>
                    <TH>Bookings from</TH>
                    <TH>Last delivery</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {endpoints.map((e) => (
                    <TR key={e.id}>
                      <TD>
                        <code className="break-all font-mono text-xs">{e.url}</code>
                        {e.description ? <span className="block text-xs text-muted">{e.description}</span> : null}
                        <span className="block text-xs text-muted">
                          Secret <span className="font-mono">{e.secret_prefix}…</span>
                        </span>
                        {!e.enabled ? <Badge tone="neutral">Disabled</Badge> : null}
                      </TD>
                      <TD className="text-xs">{e.events.join(", ")}</TD>
                      <TD>{e.team_name ? `Partner: ${e.team_name}` : "All booking pages"}</TD>
                      <TD className="text-xs">
                        {e.last_delivery_at ? (
                          <>
                            {formatDateTime(e.last_delivery_at, zone)}
                            <span className="block">
                              {e.last_status ?? "No response"}
                              {e.consecutive_failures ? ` · ${e.consecutive_failures} failed in a row` : ""}
                            </span>
                          </>
                        ) : (
                          "Never"
                        )}
                      </TD>
                      <TD className="space-y-2 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <ActionButton action={testWebhookAction} hidden={{ id: e.id }} size="sm" variant="secondary" pendingLabel="Queuing…">
                            Send test
                          </ActionButton>
                          <ActionButton action={toggleWebhookAction} hidden={{ id: e.id, enable: e.enabled ? "0" : "1" }} size="sm" variant="secondary" pendingLabel="Working…">
                            {e.enabled ? "Disable" : "Enable"}
                          </ActionButton>
                          <ConfirmAction
                            action={deleteWebhookAction}
                            hidden={{ id: e.id }}
                            trigger="Delete"
                            triggerSize="sm"
                            title="Delete this webhook?"
                            description="Deliveries stop immediately and its delivery history is removed."
                            confirmLabel="Delete webhook"
                          />
                        </div>
                        <RotateSecretButton id={e.id} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No webhooks yet.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent deliveries" description="The last 50 deliveries. Delivery records are kept for 30 days." />
          <CardBody>
            {deliveries.length ? (
              <Table caption="Recent webhook deliveries">
                <THead>
                  <TR>
                    <TH>Time</TH>
                    <TH>Endpoint</TH>
                    <TH>Event</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Attempts</TH>
                  </TR>
                </THead>
                <TBody>
                  {deliveries.map((d) => (
                    <TR key={d.id}>
                      <TD className="whitespace-nowrap">{formatDateTime(d.created_at, zone)}</TD>
                      <TD>
                        <code className="break-all font-mono text-xs">{d.url}</code>
                      </TD>
                      <TD>
                        <code className="font-mono text-xs">{d.event}</code>
                      </TD>
                      <TD>
                        <Badge tone={DELIVERY_TONE[d.status] ?? "neutral"}>{d.status}</Badge>
                        <span className="block text-xs text-muted">{d.response_status ? `HTTP ${d.response_status}` : (d.error ?? "")}</span>
                      </TD>
                      <TD className="text-right tabular-nums">{d.attempts}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No deliveries yet.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
