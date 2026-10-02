import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Toast";
import StatCard from "@/components/reactbits/StatCard";
import { CopyButton } from "@/components/app/CopyButton";
import { formatRange, formatRelative, LOCATION_LABELS } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

type Upcoming = {
  id: string;
  start_at: Date;
  end_at: Date;
  status: string;
  invitee_name: string;
  location_type: string;
  event_type_name: string;
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;

  const data = await withUser(user.id, async (tx) => {
    const upcoming = await tx<Upcoming[]>`
      select b.id, b.start_at, b.end_at, b.status, b.invitee_name, b.location_type, et.name as event_type_name
      from app.bookings b
      join app.booking_hosts bh on bh.booking_id = b.id and bh.user_id = ${user.id} and bh.active
      join app.event_types et on et.id = b.event_type_id
      where b.status in ('confirmed', 'flagged')
        and b.start_at >= now() and b.start_at < now() + interval '7 days'
      order by b.start_at
      limit 50
    `;
    const [counts] = await tx<{ last30: number; flagged: number; event_types: number }[]>`
      select
        (select count(*)::int from app.bookings b
           join app.booking_hosts bh on bh.booking_id = b.id and bh.user_id = ${user.id}
           where b.status in ('confirmed', 'flagged') and b.start_at >= now() - interval '30 days' and b.start_at < now()) as last30,
        (select count(*)::int from app.bookings b
           join app.booking_hosts bh on bh.booking_id = b.id and bh.user_id = ${user.id} and bh.active
           where b.status = 'flagged' and b.start_at >= now()) as flagged,
        (select count(*)::int from app.event_types where owner_user_id = ${user.id} and is_active) as event_types
    `;
    const [calendar] = await tx<{ status: string; last_synced_at: Date | null; last_error: string | null; broken_at: Date | null }[]>`
      select status, last_synced_at, last_error, broken_at from app.calendar_connections where user_id = ${user.id}
    `;
    const teams = await tx<{ id: string; name: string; status: string; source: string }[]>`
      select t.id, t.name, tm.status, tm.source
      from app.team_members tm join app.teams t on t.id = tm.team_id
      where tm.user_id = ${user.id}
      order by t.name
    `;
    return { upcoming, counts, calendar, teams };
  });

  const publicPath = `/${user.slug}`;

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        description="Your schedule at a glance."
        actions={
          <>
            <ButtonLink href="/event-types/new" variant="secondary">
              New event type
            </ButtonLink>
            <ButtonLink href="/bookings">View all bookings</ButtonLink>
          </>
        }
      />

      {sp.error === "forbidden" ? (
        <Notice tone="warning" title="You do not have access to that page" className="mb-6">
          The page you tried to open is limited to administrators.
        </Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard index={0} label="Next 7 days" value={data.upcoming.length} hint="Upcoming meetings you host" href="/bookings" tone="highlight" />
        <StatCard index={1} label="Last 30 days" value={data.counts.last30} hint="Meetings held" href="/bookings?tab=past" />
        <StatCard index={2} label="Active event types" value={data.counts.event_types} hint="Your individual booking pages" href="/event-types" />
        <StatCard
          index={3}
          label="Flagged"
          value={data.counts.flagged}
          hint="Upcoming bookings needing review"
          href="/bookings?status=flagged"
          tone={data.counts.flagged > 0 ? "warning" : "default"}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" aria-labelledby="upcoming-h">
          <CardHeader id="upcoming-h" title="Upcoming in the next 7 days" description={`${data.upcoming.length} meeting${data.upcoming.length === 1 ? "" : "s"}`} />
          <CardBody flush>
            {data.upcoming.length === 0 ? (
              <EmptyState className="m-5" title="Nothing scheduled this week" description="Share your booking page to start receiving meetings." />
            ) : (
              <ul className="divide-y divide-border">
                {data.upcoming.map((b) => (
                  <li key={b.id}>
                    <Link href={`/bookings/${b.id}`} className="flex flex-col gap-1 px-5 py-3 hover:bg-surface-alt sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-navy">{b.invitee_name}</p>
                        <p className="truncate text-sm text-muted">
                          {b.event_type_name} · {LOCATION_LABELS[b.location_type] ?? b.location_type}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-sm text-ink">
                        {b.status === "flagged" ? <StatusBadge status="flagged" /> : null}
                        <span>{formatRange(b.start_at, b.end_at, user.timezone)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card aria-labelledby="cal-h">
            <CardHeader id="cal-h" title="Outlook calendar" actions={<StatusBadge status={data.calendar?.status ?? "disconnected"} />} />
            <CardBody className="space-y-2 text-sm">
              {data.calendar?.status === "healthy" ? (
                <p className="text-ink">Your calendar is connected. Busy times block your availability and new bookings are added to Outlook.</p>
              ) : (
                <p className="text-ink">Bookings cannot be written to your calendar and round-robin skips you until you reconnect.</p>
              )}
              <p className="text-muted">Last synced: {formatRelative(data.calendar?.last_synced_at)}</p>
              {data.calendar?.status !== "healthy" ? (
                <a href={`/api/auth/login?reconnect=1&returnTo=${encodeURIComponent("/dashboard")}`} className="inline-flex font-semibold text-primary underline">
                  Reconnect Outlook
                </a>
              ) : null}
            </CardBody>
          </Card>

          <Card aria-labelledby="link-h">
            <CardHeader id="link-h" title="Your booking page" />
            <CardBody className="space-y-3">
              <p className="break-all rounded-md bg-surface-alt px-3 py-2 font-mono text-sm text-navy">{publicPath}</p>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={publicPath} />
                <ButtonLink href={publicPath} variant="ghost" size="sm" target="_blank" rel="noopener">
                  Open page
                </ButtonLink>
              </div>
            </CardBody>
          </Card>

          <Card aria-labelledby="teams-h">
            <CardHeader id="teams-h" title="Your teams" />
            <CardBody flush>
              {data.teams.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">You are not a member of any team yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.teams.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 px-5 py-3">
                      <Link href={`/teams/${t.id}`} className="truncate font-medium text-navy hover:text-primary hover:underline">
                        {t.name}
                      </Link>
                      <span className="flex items-center gap-1.5">
                        {t.source === "queue" ? <Badge>Queue</Badge> : null}
                        <StatusBadge status={t.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
