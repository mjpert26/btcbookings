import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { isUuid } from "@/server/ui/form";
import { resolveVariant, type EventTypeBundle, type Provenance, type ResolvedEventType } from "@/server/scheduling/resolve";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Toast";
import { ActionButton } from "@/components/app/ActionButton";
import { VARIANT_GROUPS, type VariantGroupKey } from "@/lib/event-types";
import { formatMinutes, LOCATION_LABELS } from "@/lib/format";
import { pickLocalized } from "@/i18n/locales";
import { canWrite, loadBundle, type HostRow } from "../../_data";
import { createSpanishVariantAction, toggleOverrideAction } from "../../_actions";
import { GroupToggle } from "./GroupToggle";

export const metadata: Metadata = { title: "Language variants" };

function ProvenanceBadge({ p }: { p: Provenance }) {
  if (p === "inherited") return <Badge tone="primary">Inherited</Badge>;
  if (p === "overridden") return <Badge tone="warning">Overridden</Badge>;
  return <Badge tone="neutral">Own</Badge>;
}

type Bundle = EventTypeBundle<HostRow>;

function groupSummary(group: VariantGroupKey, b: Bundle | ResolvedEventType<HostRow>, isAdmin: boolean): ReactNode {
  const et = b.eventType;
  switch (group) {
    case "durations":
      return (
        <>
          {et.durations.map(formatMinutes).join(", ")}
          <span className="block text-xs text-muted">Default {formatMinutes(et.default_duration)}</span>
        </>
      );
    case "questions":
      return b.questions.length ? (
        <ol className="list-decimal space-y-0.5 pl-4">
          {b.questions.map((q) => (
            <li key={q.id ?? q.key}>
              {pickLocalized(q.label, et.language)} <span className="text-xs text-muted">({q.key}{q.required ? ", required" : ""})</span>
            </li>
          ))}
        </ol>
      ) : (
        <span className="text-muted">No extra questions</span>
      );
    case "location":
      return (
        <>
          {LOCATION_LABELS[et.location_type] ?? et.location_type}
          {et.location_detail ? <span className="block text-xs text-muted">{et.location_detail}</span> : null}
        </>
      );
    case "buffers":
      return (
        <>
          Before {et.buffer_before_min} min · After {et.buffer_after_min} min
          <span className="block text-xs text-muted">Minimum notice {formatMinutes(et.min_notice_min)}</span>
        </>
      );
    case "branding":
      return (
        <>
          <span className="flex items-center gap-2">
            Accent{" "}
            {et.brand_accent ? (
              <>
                <span aria-hidden="true" className="inline-block size-3 rounded-full border border-border" style={{ background: et.brand_accent }} />
                {et.brand_accent}
              </>
            ) : (
              "default"
            )}
          </span>
          <span className="mt-1 block text-xs text-muted">{pickLocalized(et.description, et.language) || "No description"}</span>
        </>
      );
    case "sf_settings":
      if (!isAdmin) return <span className="text-muted">Visible to admins only</span>;
      return b.sfSettings ? (
        <>
          Lead creation {b.sfSettings.create_sf_lead ? "on" : "off"}
          <span className="block text-xs text-muted">{Object.keys(b.sfSettings.field_mapping ?? {}).length} mapped fields</span>
        </>
      ) : (
        <span className="text-muted">Not configured</span>
      );
  }
}

function OwnRow({ label, parent, child }: { label: string; parent: ReactNode; child: ReactNode }) {
  return (
    <tr className="align-top">
      <th scope="row" className="px-4 py-3 text-left font-semibold text-navy">
        {label}
        <div className="mt-1">
          <ProvenanceBadge p="own" />
        </div>
      </th>
      <td className="px-4 py-3">{parent}</td>
      <td className="px-4 py-3">{child}</td>
    </tr>
  );
}

export default async function VariantsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const isAdmin = user.role === "admin";

  const data = await withUser(user.id, async (tx) => {
    if (!(await canWrite(tx, id))) return null;
    const parent = await loadBundle(tx, id);
    if (!parent) return null;
    if (parent.eventType.parent_event_type_id) return { redirectTo: parent.eventType.parent_event_type_id };
    const childIds = await tx<{ id: string }[]>`select id from app.event_types where parent_event_type_id = ${id} order by language`;
    const children: Bundle[] = [];
    for (const c of childIds) {
      const b = await loadBundle(tx, c.id);
      if (b) children.push(b);
    }
    return { parent, children };
  });
  if (!data) notFound();
  if ("redirectTo" in data) redirect(`/event-types/${data.redirectTo}/variants`);
  const { parent, children } = data;
  const p = parent.eventType;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/event-types", label: "Event types" },
          { href: `/event-types/${id}`, label: p.name },
        ]}
        title="Language variants"
        description="Variants share the slug and inherit grouped settings from the English page. Routing (hosts, strategy, schedule) always belongs to each variant."
        actions={
          p.language === "en" && !children.some((c) => c.eventType.language === "es") ? (
            <ActionButton action={createSpanishVariantAction.bind(null, id)} variant="primary" pendingLabel="Creating…">
              Add Spanish variant
            </ActionButton>
          ) : null
        }
      />
      {sp.created ? (
        <Notice tone="success" title="Spanish variant created" className="mb-6">
          Everything is inherited for now and the variant is turned off. Translate its name and description, then turn it on.
        </Notice>
      ) : null}

      {children.length === 0 ? (
        <EmptyState title="No variants yet" description="Add a Spanish variant to route Spanish-speaking invitees to different hosts while sharing settings." />
      ) : (
        children.map((child) => {
          const r = resolveVariant(parent, child);
          const c = r.eventType;
          return (
            <Card key={c.id} className="mb-6" aria-labelledby={`v-${c.id}`}>
              <CardHeader
                id={`v-${c.id}`}
                title={
                  <span className="flex items-center gap-2">
                    {c.name} <Badge tone="warning">{c.language.toUpperCase()}</Badge> {!c.is_active ? <Badge>Off</Badge> : null}
                  </span>
                }
                actions={
                  <Link href={`/event-types/${c.id}`} className="text-sm font-semibold text-primary hover:underline">
                    Edit variant
                  </Link>
                }
              />
              <CardBody flush>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[48rem] text-sm">
                    <caption className="sr-only">
                      Side-by-side comparison of {p.name} and its {c.language.toUpperCase()} variant
                    </caption>
                    <thead className="border-b border-border bg-surface-alt text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th scope="col" className="w-56 px-4 py-2.5 text-left">
                          Setting
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-left">
                          Parent ({p.language.toUpperCase()})
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-left">
                          Variant ({c.language.toUpperCase()}, effective)
                        </th>
                        <th scope="col" className="w-64 px-4 py-2.5 text-left">
                          Inheritance
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {VARIANT_GROUPS.map((g) => {
                        const prov = r.groups[g.key];
                        const lockedSf = g.key === "sf_settings" && !isAdmin;
                        return (
                          <tr key={g.key} className={prov === "overridden" ? "bg-warning/5 align-top" : "align-top"}>
                            <th scope="row" className="px-4 py-3 text-left font-semibold text-navy">
                              {g.label}
                              <div className="mt-1">
                                <ProvenanceBadge p={prov} />
                              </div>
                              <p className="mt-1 text-xs font-normal text-muted">{g.description}</p>
                            </th>
                            <td className="px-4 py-3">{groupSummary(g.key, parent, isAdmin)}</td>
                            <td className="px-4 py-3">{groupSummary(g.key, r, isAdmin)}</td>
                            <td className="px-4 py-3">
                              {lockedSf ? (
                                <p className="text-xs text-muted">Only admins can change Salesforce inheritance.</p>
                              ) : (
                                <GroupToggle action={toggleOverrideAction.bind(null, c.id)} group={g.key} label={g.label} overridden={prov === "overridden"} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      <OwnRow label="Name" parent={p.name} child={c.name} />
                      <OwnRow label="Accepting bookings" parent={p.is_active ? "Yes" : "No"} child={c.is_active ? "Yes" : "No"} />
                      <OwnRow
                        label="Routing"
                        parent={p.scheduling_mode === "individual" ? "Individual" : `${p.scheduling_mode.replace("_", "-")} · ${p.rr_strategy} · ${parent.hosts.length || "all"} hosts`}
                        child={c.scheduling_mode === "individual" ? "Individual" : `${c.scheduling_mode.replace("_", "-")} · ${c.rr_strategy} · ${child.hosts.length || "all"} hosts`}
                      />
                      <OwnRow label="Booking window" parent={`${p.booking_window_days} days`} child={`${c.booking_window_days} days`} />
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          );
        })
      )}
    </>
  );
}
