import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { ISO_FIELD, SF_SETTINGS_OVERRIDE_KEY } from "@/server/salesforce/settings";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { ButtonLink } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Lead routing" };

type Row = {
  id: string;
  name: string;
  language: string;
  is_active: boolean;
  parent_event_type_id: string | null;
  overrides_sf: boolean;
  owner_name: string | null;
  team_name: string | null;
  create_sf_lead: boolean | null;
  iso: string | null;
  owner_mode: string | null;
  has_own_settings: boolean;
};

const OWNER_MODE_LABEL: Record<string, string> = {
  assigned_host: "Assigned host",
  fixed: "Fixed user",
  assignment_rules: "Assignment rules",
};

/**
 * Every booking page with its Salesforce lead settings (create-lead toggle, ISO, owner mode).
 * Variants without their own settings show the parent's values as inherited.
 */
export default async function LeadRoutingPage() {
  const user = await requireAdmin();
  const rows = await withUser(user.id, (tx) => tx<Row[]>`
    select et.id, et.name, et.language, et.is_active, et.parent_event_type_id,
           (${SF_SETTINGS_OVERRIDE_KEY} = any (et.overrides)) as overrides_sf,
           u.name as owner_name, t.name as team_name,
           coalesce(own.create_sf_lead, par.create_sf_lead) as create_sf_lead,
           coalesce(own.static_values, par.static_values) ->> ${ISO_FIELD} as iso,
           coalesce(own.owner_mode, par.owner_mode)::text as owner_mode,
           (own.event_type_id is not null) as has_own_settings
    from app.event_types et
    left join app.users u on u.id = et.owner_user_id
    left join app.teams t on t.id = et.team_id
    left join app.event_type_sf_settings own
      on own.event_type_id = et.id
     and (et.parent_event_type_id is null or ${SF_SETTINGS_OVERRIDE_KEY} = any (et.overrides))
    left join app.event_type_sf_settings par
      on par.event_type_id = et.parent_event_type_id
     and not (${SF_SETTINGS_OVERRIDE_KEY} = any (et.overrides))
    order by coalesce(t.name, u.name), et.name, et.language
  `);

  const enabled = rows.filter((r) => r.create_sf_lead).length;
  const missingIso = rows.filter((r) => r.create_sf_lead && !r.iso).length;

  return (
    <>
      <PageHeader
        title="Lead routing"
        description="Salesforce Lead creation and the lead source (ISO) for every booking page. Settings are per booking page; Spanish and other variants inherit from their parent unless overridden."
      />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Badge tone="navy">{rows.length} booking pages</Badge>
        <Badge tone="success">{enabled} creating leads</Badge>
        {missingIso ? <Badge tone="warning">{missingIso} creating leads without an ISO</Badge> : null}
      </div>
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="No booking pages yet"
            description="Create an event type first. Its Salesforce settings, including the ISO, then appear here."
            action={<ButtonLink href="/event-types">Go to event types</ButtonLink>}
          />
        ) : (
          <Table caption="Lead settings by booking page">
            <THead>
              <TR>
                <TH>Booking page</TH>
                <TH>Owner</TH>
                <TH>Create lead</TH>
                <TH>Lead source (ISO)</TH>
                <TH>Lead owner</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => {
                const inherited = r.parent_event_type_id !== null && !r.overrides_sf;
                return (
                  <TR key={r.id}>
                    <TD>
                      <Link href={`/event-types/${r.id}`} className="font-semibold text-navy hover:underline">
                        {r.name}
                      </Link>{" "}
                      <span className="text-xs text-muted">{r.language.toUpperCase()}</span>
                      {!r.is_active ? (
                        <Badge tone="neutral" className="ml-2">
                          Inactive
                        </Badge>
                      ) : null}
                      {inherited ? <div className="text-xs text-muted">Inherits from parent</div> : null}
                    </TD>
                    <TD>{r.team_name ? `Team: ${r.team_name}` : (r.owner_name ?? "")}</TD>
                    <TD>{r.create_sf_lead ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</TD>
                    <TD className="font-mono text-xs">{r.iso ?? <span className="font-sans text-muted">Not set</span>}</TD>
                    <TD>{r.owner_mode ? (OWNER_MODE_LABEL[r.owner_mode] ?? r.owner_mode) : <span className="text-muted">Default</span>}</TD>
                    <TD className="text-right">
                      <ButtonLink href={`/admin/event-types/${inherited && r.parent_event_type_id ? r.parent_event_type_id : r.id}/salesforce`} variant="subtle" size="sm">
                        {inherited ? "Edit parent" : "Edit"}
                      </ButtonLink>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
