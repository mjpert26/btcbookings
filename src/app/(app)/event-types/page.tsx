import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Toast";
import { CopyButton } from "@/components/app/CopyButton";
import { formatMinutes, LOCATION_LABELS } from "@/lib/format";

export const metadata: Metadata = { title: "Event types" };

type Row = {
  id: string;
  name: string;
  slug: string;
  language: string;
  parent_event_type_id: string | null;
  is_active: boolean;
  is_listed: boolean;
  durations: number[];
  location_type: string;
  scheduling_mode: string;
  team_id: string | null;
  team_name: string | null;
  team_slug: string | null;
  upcoming: number;
};

function EventTypeCard({ et, variants, publicPath }: { et: Row; variants: Row[]; publicPath: string }) {
  return (
    <li className="group relative flex flex-col rounded-brand border border-border bg-surface shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
      <div aria-hidden="true" className={`h-1.5 rounded-t-brand ${et.is_active ? "bg-gradient-to-r from-primary to-sky" : "bg-border"}`} />
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold">
            <Link href={`/event-types/${et.id}`} className="after:absolute after:inset-0 hover:text-primary">
              {et.name}
            </Link>
          </h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <Badge tone="primary">{et.language.toUpperCase()}</Badge>
            {variants.map((v) => (
              <Badge key={v.id} tone="warning">
                {v.language.toUpperCase()}
              </Badge>
            ))}
          </div>
        </div>
        <p className="text-sm text-muted">
          {et.durations.map(formatMinutes).join(" / ")} · {LOCATION_LABELS[et.location_type] ?? et.location_type}
          {et.scheduling_mode !== "individual" ? ` · ${et.scheduling_mode === "round_robin" ? "Round-robin" : "Collective"}` : ""}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {et.is_active ? <Badge tone="success">Accepting bookings</Badge> : <Badge>Off</Badge>}
          {!et.is_listed ? <Badge>Unlisted</Badge> : null}
          {et.upcoming ? <Badge tone="navy">{et.upcoming} upcoming</Badge> : null}
        </div>
        <p className="mt-auto truncate font-mono text-xs text-muted">{publicPath}</p>
      </div>
      <div className="relative z-10 flex items-center gap-2 border-t border-border px-5 py-3">
        <CopyButton text={publicPath} />
        {variants.length ? (
          <Link href={`/event-types/${et.id}/variants`} className="text-sm font-semibold text-primary hover:underline">
            Variants
          </Link>
        ) : null}
      </div>
    </li>
  );
}

export default async function EventTypesPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const rows = await withUser(user.id, (tx) => tx<Row[]>`
    select et.id, et.name, et.slug, et.language, et.parent_event_type_id, et.is_active, et.is_listed, et.durations,
           et.location_type, et.scheduling_mode, et.team_id, t.name as team_name, t.slug as team_slug,
           (select count(*)::int from app.bookings b where b.event_type_id = et.id and b.status in ('confirmed', 'flagged') and b.start_at > now()) as upcoming
    from app.event_types et
    left join app.teams t on t.id = et.team_id
    where (et.owner_user_id = ${user.id} or (et.team_id is not null and app.is_team_admin(et.team_id)))
    order by t.name nulls first, et.name, et.language
  `);

  const parents = rows.filter((r) => !r.parent_event_type_id || !rows.some((p) => p.id === r.parent_event_type_id));
  const variantsOf = (id: string) => rows.filter((r) => r.parent_event_type_id === id);
  const mine = parents.filter((r) => !r.team_id);
  const teamGroups = new Map<string, { name: string; slug: string; items: Row[] }>();
  for (const r of parents.filter((r) => r.team_id)) {
    const g = teamGroups.get(r.team_id!) ?? { name: r.team_name ?? "", slug: r.team_slug ?? "", items: [] };
    g.items.push(r);
    teamGroups.set(r.team_id!, g);
  }

  return (
    <>
      <PageHeader title="Event types" description="Booking pages you own, and team pages you manage." actions={<ButtonLink href="/event-types/new">New event type</ButtonLink>} />
      {sp.deleted ? (
        <Notice tone="success" className="mb-6">
          Event type deleted.
        </Notice>
      ) : null}

      <section aria-labelledby="mine-h" className="mb-10">
        <h2 id="mine-h" className="mb-3 text-lg font-semibold">
          Your event types
        </h2>
        {mine.length === 0 ? (
          <EmptyState title="No event types yet" description="Create your first booking page to start sharing your availability." action={<ButtonLink href="/event-types/new">Create event type</ButtonLink>} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {mine.map((et) => (
              <EventTypeCard key={et.id} et={et} variants={variantsOf(et.id)} publicPath={`/${user.slug}/${et.slug}`} />
            ))}
          </ul>
        )}
      </section>

      {[...teamGroups.entries()].map(([teamId, g]) => (
        <section key={teamId} aria-labelledby={`team-${teamId}`} className="mb-10">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id={`team-${teamId}`} className="text-lg font-semibold">
              {g.name}
            </h2>
            <ButtonLink href={`/event-types/new?team=${teamId}`} variant="ghost" size="sm">
              New team event type
            </ButtonLink>
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((et) => (
              <EventTypeCard key={et.id} et={et} variants={variantsOf(et.id)} publicPath={`/t/${g.slug}/${et.slug}`} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
