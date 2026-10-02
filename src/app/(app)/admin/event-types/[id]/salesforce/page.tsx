import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { isUuid } from "@/server/ui/form";
import { resolveVariant, type EventTypeSfSettingsRow } from "@/server/scheduling/resolve";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Notice } from "@/components/ui/Toast";
import { pickLocalized } from "@/i18n/locales";
import { ISO_FIELD, SF_BUILTIN_SOURCES } from "@/lib/salesforce";
import { loadBundle } from "../../../../event-types/_data";
import { toggleOverrideAction } from "../../../../event-types/_actions";
import { GroupToggle } from "../../../../event-types/[id]/variants/GroupToggle";
import { saveSfSettingsAction } from "../../../_actions/salesforce";
import { SfSettingsForm, type SfFormValues } from "./SfSettingsForm";

export const metadata: Metadata = { title: "Salesforce settings" };

function toValues(row: EventTypeSfSettingsRow | null): SfFormValues {
  const statics = { ...((row?.static_values ?? {}) as Record<string, unknown>) };
  const iso = typeof statics[ISO_FIELD] === "string" ? (statics[ISO_FIELD] as string) : "";
  delete statics[ISO_FIELD];
  return {
    createSfLead: row?.create_sf_lead ?? false,
    isoAccountId: iso,
    campaignId: row?.campaign_id ?? "",
    ownerMode: row?.owner_mode ?? "assigned_host",
    ownerFixedId: row?.owner_fixed_id ?? "",
    fieldMapping: Object.entries(row?.field_mapping ?? {}).map(([source, field]) => ({ source, field: String(field) })),
    staticValues: Object.entries(statics).map(([key, value]) => ({ key, value: String(value ?? "") })),
  };
}

export default async function SalesforceSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const data = await withUser(user.id, async (tx) => {
    const bundle = await loadBundle(tx, id);
    if (!bundle) return null;
    const parent = bundle.eventType.parent_event_type_id ? await loadBundle(tx, bundle.eventType.parent_event_type_id) : null;
    const [counts] = await tx<{ total: number; failed: number }[]>`
      select count(*)::int as total, count(*) filter (where status in ('failed', 'dead'))::int as failed
      from app.sf_lead_jobs where event_type_id = ${id}
    `;
    return { bundle, parent, counts };
  });
  if (!data) notFound();
  const { bundle, parent, counts } = data;
  const resolved = resolveVariant(parent, bundle);
  const et = bundle.eventType;
  const inherited = resolved.groups.sf_settings === "inherited";
  const sources = [
    ...SF_BUILTIN_SOURCES.map((s) => ({ value: s.value as string, label: s.label as string })),
    ...resolved.questions.map((q) => ({ value: `q:${q.key}`, label: `${pickLocalized(q.label, "en") || q.key} (q:${q.key})` })),
  ];
  // Keep sources that are saved but no longer exist (for example a removed question) visible,
  // so the admin can see and fix them instead of silently losing the mapping.
  for (const src of Object.keys(resolved.sfSettings?.field_mapping ?? {})) {
    if (!sources.some((s) => s.value === src)) sources.push({ value: src, label: `${src} (missing question)` });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/admin", label: "Admin" },
          { href: `/event-types/${id}`, label: et.name },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Salesforce settings <Badge tone="primary">{et.language.toUpperCase()}</Badge>
            {resolved.sfSettings?.create_sf_lead ? <Badge tone="success">Lead creation on</Badge> : <Badge>Lead creation off</Badge>}
          </span>
        }
        description={`${et.name}. Leads are created through n8n with an idempotency key per booking.`}
        actions={
          <Link href={`/admin/salesforce/jobs?eventType=${id}`} className="text-sm font-semibold text-primary hover:underline">
            Lead jobs ({counts.total}
            {counts.failed ? `, ${counts.failed} failed` : ""})
          </Link>
        }
      />

      {parent ? (
        <Card className="mb-6" aria-labelledby="inherit-h">
          <CardHeader id="inherit-h" title="Variant inheritance" description={`This is the ${et.language.toUpperCase()} variant of "${parent.eventType.name}".`} />
          <CardBody className="space-y-3">
            <GroupToggle action={toggleOverrideAction.bind(null, id)} group="sf_settings" label="Salesforce settings" overridden={!inherited} />
            {inherited ? (
              <Notice tone="info">
                Inheriting from the parent. The settings below are the parent&apos;s and are read-only here.{" "}
                <Link href={`/admin/event-types/${parent.eventType.id}/salesforce`} className="font-semibold text-primary underline">
                  Edit the parent&apos;s settings
                </Link>
                .
              </Notice>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <SfSettingsForm
        key={inherited ? "inherited" : "own"}
        action={saveSfSettingsAction.bind(null, id)}
        values={toValues(resolved.sfSettings)}
        sources={sources}
        readOnly={inherited}
      />
    </>
  );
}
