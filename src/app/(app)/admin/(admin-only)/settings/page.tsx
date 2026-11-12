import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireAdmin } from "@/server/auth/session";
import { listIntegrationSettings, type SettingSource, type SettingView } from "@/server/settings/admin";
import { bootstrapStatus, MAX_VALUE_LENGTH, SETTING_GROUPS, type SettingGroupId } from "@/server/settings/keys";
import type { CheckService } from "@/server/settings/checks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Notice } from "@/components/ui/Toast";
import { ActionForm } from "@/components/ui/Form";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ActionButton } from "@/components/app/ActionButton";
import { ConfirmAction } from "@/components/app/ConfirmAction";
import { formatDateTime } from "@/lib/format";
import { removeSettingAction, saveSettingAction, testSettingsAction } from "../../_actions/settings";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const SOURCE: Record<SettingSource, { tone: BadgeTone; label: string }> = {
  panel: { tone: "primary", label: "Set here" },
  vercel: { tone: "navy", label: "From Vercel" },
  default: { tone: "neutral", label: "Default" },
  unset: { tone: "warning", label: "Not set" },
};

/** Test button per group. Each one reaches only the signed-in admin, or no one. */
const TESTS: Partial<Record<SettingGroupId, { service: CheckService; label: string; note: string }>> = {
  email: { service: "email", label: "Send test email", note: "Sends one test email to your own address." },
  sms: {
    service: "sms",
    label: "Send test text",
    note: "SendBlue has no read-only check here, so this sends one test text to your own mobile number from Availability > Booking preferences.",
  },
  slack: { service: "slack", label: "Check token", note: "Calls Slack auth.test. Nothing is posted." },
  turnstile: {
    service: "turnstile",
    label: "Check secret key",
    note: "Asks Cloudflare to verify a dummy token. A rejected token with an accepted secret means the secret key is valid.",
  },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-1 sm:grid-cols-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 sm:col-span-2">{children}</dd>
    </div>
  );
}

function currentValue(s: SettingView): ReactNode {
  if (s.isSecret) {
    return s.last4 ? <span className="font-mono text-xs">Ends in {s.last4}</span> : <span className="text-muted">None</span>;
  }
  return s.value ? <code className="break-all font-mono text-xs">{s.value}</code> : <span className="text-muted">None</span>;
}

function SettingItem({ s, zone }: { s: SettingView; zone: string }) {
  const source = SOURCE[s.source];
  const inPanel = s.source === "panel";
  return (
    <li className="grid gap-4 py-4 lg:grid-cols-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{s.label}</span>
          <Badge tone={source.tone}>{source.label}</Badge>
          {s.isSecret ? <Badge tone="neutral">Secret</Badge> : null}
        </div>
        <code className="font-mono text-xs text-muted">{s.key}</code>
        <p className="mt-1 text-xs text-muted">{s.hint}</p>
        <dl className="mt-2 text-sm">
          <Row label={s.isSecret ? "Active value" : "Value"}>{currentValue(s)}</Row>
          {inPanel ? (
            <Row label="Updated">
              {s.updatedByName ?? "A former user"}
              {s.updatedAt ? `, ${formatDateTime(s.updatedAt, zone)}` : ""}
            </Row>
          ) : null}
        </dl>
      </div>
      <div className="space-y-2">
        {/* Keyed by the stored state so the field is cleared after a save or removal. */}
        <ActionForm key={`${s.key}:${s.updatedAt?.toISOString() ?? s.source}`} action={saveSettingAction} aria-label={`Set ${s.key}`} className="space-y-2">
          <input type="hidden" name="key" value={s.key} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input
              name="value"
              label={inPanel ? "New value" : "Value"}
              type={s.isSecret ? "password" : "text"}
              autoComplete={s.isSecret ? "new-password" : "off"}
              spellCheck={false}
              maxLength={MAX_VALUE_LENGTH}
              placeholder={s.placeholder ?? undefined}
              required
              wrapperClassName="flex-1"
            />
            <SubmitButton pendingLabel="Saving…">{inPanel ? "Replace" : "Set here"}</SubmitButton>
          </div>
        </ActionForm>
        {inPanel ? (
          <ConfirmAction
            action={removeSettingAction}
            hidden={{ key: s.key }}
            trigger="Remove"
            triggerSize="sm"
            title={`Remove ${s.key}?`}
            description="The value set here is deleted. The app uses the Vercel value again, or treats the key as not set if Vercel has none."
            confirmLabel="Remove value"
          />
        ) : null}
      </div>
    </li>
  );
}

export default async function AdminSettingsPage() {
  const user = await requireAdmin();
  const settings = await listIntegrationSettings(user);
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const bootstrap = bootstrapStatus();
  const zone = user.timezone;
  const turnstileHalfSet =
    (byKey.get("TURNSTILE_SITE_KEY")?.source === "unset") !== (byKey.get("TURNSTILE_SECRET_KEY")?.source === "unset");

  return (
    <>
      <PageHeader
        title="Settings"
        description="Keys for email, text messages, Slack, bot protection and Salesforce. A value set here overrides the Vercel variable of the same name and takes effect within 30 seconds, without a redeploy. Remove it to fall back to Vercel."
      />
      <div className="space-y-6">
        <Notice tone="info">
          Secrets are encrypted and write-only: after you save one, only its last four characters are shown. Every change is recorded in the audit log without
          the value. When you replace a key that was set in Vercel, also remove or rotate the old value there.
        </Notice>

        {SETTING_GROUPS.map((group) => {
          const test = TESTS[group.id];
          return (
            <Card key={group.id} aria-labelledby={`settings-${group.id}`}>
              <CardHeader
                id={`settings-${group.id}`}
                title={group.title}
                description={test ? `${group.description} ${test.note}` : group.description}
                actions={
                  test ? (
                    <ActionButton action={testSettingsAction} hidden={{ service: test.service }} size="sm" variant="secondary" pendingLabel="Testing…">
                      {test.label}
                    </ActionButton>
                  ) : null
                }
              />
              <CardBody>
                {group.id === "turnstile" && turnstileHalfSet ? (
                  <Notice tone="warning" className="mb-2">
                    Only one Turnstile key is set. Set both keys or neither: with only the secret key, the public forms cannot pass the check; with only the
                    site key, the check is shown but not verified.
                  </Notice>
                ) : null}
                <ul className="divide-y divide-border">
                  {group.keys.map((key) => {
                    const s = byKey.get(key);
                    return s ? <SettingItem key={key} s={s} zone={zone} /> : null;
                  })}
                </ul>
              </CardBody>
            </Card>
          );
        })}

        <Card aria-labelledby="settings-vercel">
          <CardHeader
            id="settings-vercel"
            title="Set in Vercel"
            description="Bootstrap configuration stays in the Vercel environment and cannot be changed here. Change it in Vercel and redeploy. Values are never shown."
          />
          <CardBody>
            <Table caption="Variables set in Vercel">
              <THead>
                <TR>
                  <TH>Variable</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {bootstrap.map((b) => (
                  <TR key={b.name}>
                    <TD>
                      <code className="font-mono text-xs">{b.name}</code>
                      {b.required ? null : <span className="ml-2 text-xs text-muted">optional</span>}
                    </TD>
                    <TD>{b.set ? <Badge tone="success">Set</Badge> : <Badge tone={b.required ? "danger" : "neutral"}>Missing</Badge>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
