import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { service, withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Teams" };

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual roster",
  salesforce_queue: "Salesforce Queue",
  queue_plus_manual: "Queue + manual",
};

export default async function TeamsPage() {
  const user = await requireUser();
  const teams = await withUser(user.id, (tx) => tx<
    { id: string; name: string; slug: string; description: string | null; membership_source: string; my_status: string | null; is_team_admin: boolean }[]
  >`
    select t.id, t.name, t.slug, t.description, t.membership_source,
           (select tm.status from app.team_members tm where tm.team_id = t.id and tm.user_id = ${user.id} limit 1) as my_status,
           app.is_team_admin(t.id) as is_team_admin
    from app.teams t
    order by t.name
  `);
  // Member counts are aggregate numbers only; team_members RLS would hide rows of teams the
  // user does not belong to, so counts come from the service connection.
  const counts = await service()<{ team_id: string; active: number; total: number }[]>`
    select team_id, count(*) filter (where status = 'active')::int as active, count(*)::int as total
    from app.team_members group by team_id
  `;
  const countOf = new Map(counts.map((c) => [c.team_id, c]));

  return (
    <>
      <PageHeader title="Teams" description="Teams share booking pages and distribute meetings by round-robin or collective scheduling." />
      {teams.length === 0 ? (
        <EmptyState title="No teams yet" description="Admins create teams and link them to Salesforce Queues." />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {teams.map((t) => {
            const c = countOf.get(t.id);
            return (
              <li key={t.id} className="relative flex flex-col gap-3 rounded-brand border border-border bg-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold">
                    <Link href={`/teams/${t.id}`} className="after:absolute after:inset-0 hover:text-primary">
                      {t.name}
                    </Link>
                  </h2>
                  {t.is_team_admin ? <Badge tone="navy">You manage</Badge> : null}
                </div>
                {t.description ? <p className="text-sm text-muted">{t.description}</p> : null}
                <div className="mt-auto flex flex-wrap items-center gap-1.5 text-sm">
                  <Badge>{SOURCE_LABELS[t.membership_source] ?? t.membership_source}</Badge>
                  <Badge tone="primary">
                    {c?.active ?? 0} active / {c?.total ?? 0} members
                  </Badge>
                  {t.my_status ? (
                    <span className="flex items-center gap-1 text-xs text-muted">
                      You: <StatusBadge status={t.my_status} />
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
