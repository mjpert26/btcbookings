import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { isUuid } from "@/server/ui/form";
import { resolveVariant } from "@/server/scheduling/resolve";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Toast";
import { ActionButton } from "@/components/app/ActionButton";
import { ConfirmAction } from "@/components/app/ConfirmAction";
import { PublicLinks, type PublicLink } from "@/components/app/PublicLinks";
import { env } from "@/server/env";
import { VARIANT_GROUPS, type VariantGroupKey } from "@/lib/event-types";
import { EventTypeForm } from "../EventTypeForm";
import { createSpanishVariantAction, deleteEventTypeAction, updateEventTypeAction } from "../_actions";
import { canWrite, loadBundle, scheduleOptions, teamMembers } from "../_data";
import { toFormValues } from "../_values";

export const metadata: Metadata = { title: "Edit event type" };

export default async function EditEventTypePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();

  const data = await withUser(user.id, async (tx) => {
    if (!(await canWrite(tx, id))) return null;
    const bundle = await loadBundle(tx, id);
    if (!bundle) return null;
    const et = bundle.eventType;
    const parent = et.parent_event_type_id ? await loadBundle(tx, et.parent_event_type_id) : null;
    const children = await tx<{ id: string; language: string; is_active: boolean }[]>`
      select id, language, is_active from app.event_types where parent_event_type_id = ${id} order by language
    `;
    const team = et.team_id ? (await tx<{ id: string; name: string; slug: string }[]>`select id, name, slug from app.teams where id = ${et.team_id}`)[0] : null;
    const [owner] = et.owner_user_id ? await tx<{ slug: string }[]>`select slug from app.users where id = ${et.owner_user_id}` : [];
    const members = et.team_id ? await teamMembers(tx, et.team_id) : undefined;
    const schedules = await scheduleOptions(tx, et.team_id);
    return { bundle, parent, children, team, ownerSlug: owner?.slug ?? null, members, schedules };
  });
  if (!data) notFound();

  const { bundle, parent, children, team, members, schedules } = data;
  const et = bundle.eventType;
  const resolved = resolveVariant(parent, bundle);
  const inherited = VARIANT_GROUPS.map((g) => g.key).filter((g) => resolved.groups[g] === "inherited") as VariantGroupKey[];
  const isChild = Boolean(parent);
  const values = toFormValues(resolved.eventType, resolved.questions, bundle.hosts);
  const publicPath = team ? `/t/${team.slug}/${et.slug}` : data.ownerSlug ? `/${data.ownerSlug}/${et.slug}` : null;
  const familyId = parent ? parent.eventType.id : id;
  const hasSpanish = children.some((c) => c.language === "es");
  const isAdmin = user.role === "admin";

  // Public URLs of the family: the English page at the base path and the Spanish variant at /es.
  const family = parent ? [parent.eventType, et] : [et, ...children];
  const baseUrl = env().APP_BASE_URL.replace(/\/$/, "");
  const links: PublicLink[] = publicPath
    ? (["en", "es"] as const).map((language) => {
        const row = family.find((r) => r.language === language);
        return {
          language,
          label: language === "en" ? "English page" : "Spanish page",
          url: `${baseUrl}${publicPath}${language === "en" ? "" : `/${language}`}`,
          state: row ? (row.is_active ? "active" : "off") : "missing",
          current: et.language === language,
        };
      })
    : [];

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/event-types", label: "Event types" },
          ...(parent ? [{ href: `/event-types/${parent.eventType.id}`, label: parent.eventType.name }] : []),
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {et.name}
            <Badge tone={et.language === "es" ? "warning" : "primary"}>{et.language.toUpperCase()}</Badge>
            {team ? <Badge>{team.name}</Badge> : null}
            {!et.is_active ? <Badge>Off</Badge> : null}
          </span>
        }
        description={isChild ? "Spanish variant. Grouped settings are inherited from the English page unless overridden." : undefined}
        actions={
          <>
            {isChild || children.length ? (
              <ButtonLink href={`/event-types/${familyId}/variants`} variant="secondary" size="sm">
                Compare variants
              </ButtonLink>
            ) : null}
            {!isChild && et.language === "en" && !hasSpanish ? (
              <ActionButton action={createSpanishVariantAction.bind(null, id)} size="sm" pendingLabel="Creating…">
                Add Spanish variant
              </ActionButton>
            ) : null}
            {isAdmin ? (
              <ButtonLink href={`/admin/event-types/${id}/salesforce`} variant="subtle" size="sm">
                Salesforce settings
              </ButtonLink>
            ) : null}
          </>
        }
      />
      {sp.created ? (
        <Notice tone="success" title="Event type created" className="mb-6">
          Review the settings below. {team ? "Choose the host pool under Team routing." : ""}
        </Notice>
      ) : null}
      {isChild && !et.is_active ? (
        <Notice tone="info" title="This variant is off" className="mb-6">
          New variants start turned off so you can translate the name and description first. Turn on Accepting bookings when ready.
        </Notice>
      ) : null}

      {links.length ? <PublicLinks links={links} /> : null}

      <EventTypeForm
        action={updateEventTypeAction.bind(null, id)}
        values={values}
        mode="edit"
        isTeam={Boolean(team)}
        members={members}
        schedules={schedules.map((s) => ({ value: s.id, label: s.owner ? `${s.name} (${s.owner})` : s.name }))}
        inherited={inherited}
        isChild={isChild}
        variantsHref={`/event-types/${familyId}/variants`}
      />

      <section className="mt-8 rounded-brand border border-danger/30 bg-surface p-5" aria-labelledby="danger-h">
        <h2 id="danger-h" className="text-base font-semibold text-danger">
          Delete event type
        </h2>
        <p className="mt-1 text-sm text-muted">Deleting removes the booking page{children.length ? " and its language variants" : ""}. Event types with bookings cannot be deleted; turn them off instead.</p>
        <div className="mt-3">
          <ConfirmAction
            action={deleteEventTypeAction.bind(null, id)}
            trigger="Delete event type"
            title={`Delete "${et.name}"?`}
            description="This cannot be undone."
            confirmLabel="Delete"
          />
        </div>
      </section>
    </>
  );
}
