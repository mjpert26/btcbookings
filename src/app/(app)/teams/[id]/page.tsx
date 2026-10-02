import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { requireUser } from "@/server/auth/session";
import { service, withUser } from "@/server/db/client";
import { isUuid } from "@/server/ui/form";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Toast";
import { ActionButton } from "@/components/app/ActionButton";
import { formatDateTime } from "@/lib/format";
import { MemberEditDialog, MemberRemoveButton, MemberStatusButton } from "./MemberControls";
import { AddAdminForm, AddMemberForm, TeamSettingsForm } from "./TeamForms";
import { addMemberAction, addTeamAdminAction, removeMemberAction, removeTeamAdminAction, saveTeamSettingsAction, setMemberStatusAction, updateMemberAction } from "../_actions";

export const metadata: Metadata = { title: "Team" };

type Team = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  membership_source: string;
  outlook_conflict_policy: string;
  removal_policy: string;
  mass_removal_threshold_pct: number;
  last_synced_at: Date | null;
  sync_health: string;
  is_team_admin: boolean;
};

type Member = {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string;
  status: string;
  source: string;
  weight: number;
  priority_tier: number;
  daily_cap: number | null;
  rr_assignment_count: number;
  rr_last_assigned_at: Date | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string; created?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const isAdmin = user.role === "admin";
  const zone = user.timezone;

  const today = DateTime.now().setZone(zone).startOf("day");
  const from = sp.from && DATE_RE.test(sp.from) ? DateTime.fromISO(sp.from, { zone }) : today.minus({ days: 30 });
  const to = sp.to && DATE_RE.test(sp.to) ? DateTime.fromISO(sp.to, { zone }) : today;
  const fromAt = from.startOf("day").toJSDate();
  const toAt = to.plus({ days: 1 }).startOf("day").toJSDate();

  const data = await withUser(user.id, async (tx) => {
    const [team] = await tx<Team[]>`
      select id, name, slug, description, membership_source, outlook_conflict_policy, removal_policy,
             mass_removal_threshold_pct, last_synced_at, sync_health, app.is_team_admin(id) as is_team_admin
      from app.teams where id = ${id}
    `;
    if (!team) return null;
    const eventTypes = await tx<{ id: string; name: string; slug: string; language: string; is_active: boolean; scheduling_mode: string }[]>`
      select id, name, slug, language, is_active, scheduling_mode from app.event_types where team_id = ${id} order by name, language
    `;
    const [mine] = await tx<{ status: string }[]>`select status from app.team_members where team_id = ${id} and user_id = ${user.id}`;
    if (!team.is_team_admin) return { kind: "limited" as const, team, eventTypes, mine: mine ?? null };

    const members = await tx<Member[]>`
      select tm.id, tm.user_id, u.name, tm.email, tm.status, tm.source, tm.weight, tm.priority_tier, tm.daily_cap,
             tm.rr_assignment_count, tm.rr_last_assigned_at
      from app.team_members tm left join app.users u on u.id = tm.user_id
      where tm.team_id = ${id}
      order by tm.status, coalesce(u.name, tm.email::text)
    `;
    const admins = await tx<{ user_id: string; name: string; email: string }[]>`
      select ta.user_id, u.name, u.email from app.team_admins ta join app.users u on u.id = ta.user_id where ta.team_id = ${id} order by u.name
    `;
    const distribution = await tx<{ user_id: string; name: string; booked: number; cancelled: number }[]>`
      select bh.user_id, u.name,
             count(*) filter (where b.status in ('confirmed', 'flagged', 'rescheduled'))::int as booked,
             count(*) filter (where b.status = 'cancelled')::int as cancelled
      from app.bookings b
      join app.event_types et on et.id = b.event_type_id and et.team_id = ${id}
      join app.booking_hosts bh on bh.booking_id = b.id and bh.role = 'primary'
      join app.users u on u.id = bh.user_id
      where b.start_at >= ${fromAt} and b.start_at < ${toAt}
      group by bh.user_id, u.name
      order by booked desc, u.name
    `;
    const events = await tx<{ id: string; email: string; old_status: string | null; new_status: string | null; source: string; actor: string | null; detail: Record<string, unknown>; created_at: Date }[]>`
      select me.id, me.email, me.old_status, me.new_status, me.source, u.name as actor, me.detail, me.created_at
      from app.membership_events me left join app.users u on u.id = me.actor_user_id
      where me.team_id = ${id}
      order by me.created_at desc
      limit 50
    `;
    return { kind: "full" as const, team, eventTypes, mine: mine ?? null, members, admins, distribution, events };
  });
  if (!data) notFound();
  const { team, eventTypes } = data;

  // Outlook health for the roster. Team admins cannot read other users' calendar rows
  // through RLS, so after the team-admin check above, only the status column is read
  // for this team's members with the service connection.
  const health = new Map<string, string>();
  if (data.kind === "full") {
    const ids = data.members.map((m) => m.user_id).filter((v): v is string => Boolean(v));
    if (ids.length) {
      const rows = await service()<{ user_id: string; status: string }[]>`
        select user_id, status from app.calendar_connections where user_id = any(${ids})
      `;
      for (const r of rows) health.set(r.user_id, r.status);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ href: "/teams", label: "Teams" }]}
        title={team.name}
        description={team.description ?? undefined}
        actions={
          <>
            {team.is_team_admin ? (
              <ButtonLink href={`/event-types/new?team=${team.id}`} variant="secondary" size="sm">
                New team event type
              </ButtonLink>
            ) : null}
            {isAdmin ? (
              <>
                <ButtonLink href={`/admin/teams/${team.id}/sync`} variant="subtle" size="sm">
                  Queue sync
                </ButtonLink>
                <ButtonLink href={`/admin/teams/${team.id}/slack`} variant="subtle" size="sm">
                  Slack
                </ButtonLink>
              </>
            ) : null}
          </>
        }
      />

      {sp.created ? (
        <Notice tone="success" title="Team created" className="mb-6">
          Add members below, then create the team&apos;s booking pages with New team event type.
        </Notice>
      ) : null}

      <Card className="mb-6" aria-labelledby="pages-h">
        <CardHeader id="pages-h" title="Team booking pages" />
        <CardBody flush>
          {eventTypes.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">No team event types yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {eventTypes.map((et) => (
                <li key={et.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span className="flex items-center gap-2">
                    {team.is_team_admin ? (
                      <Link href={`/event-types/${et.id}`} className="font-semibold text-primary hover:underline">
                        {et.name}
                      </Link>
                    ) : (
                      <span className="font-semibold text-navy">{et.name}</span>
                    )}
                    <Badge tone="primary">{et.language.toUpperCase()}</Badge>
                    {!et.is_active ? <Badge>Off</Badge> : null}
                  </span>
                  <span className="font-mono text-xs text-muted">/t/{team.slug}/{et.slug}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {data.kind === "limited" ? (
        <Card aria-labelledby="you-h">
          <CardHeader id="you-h" title="Your membership" />
          <CardBody className="text-sm">
            {data.mine ? (
              <p className="flex items-center gap-2">
                Status: <StatusBadge status={data.mine.status} />
              </p>
            ) : (
              <p className="text-muted">You are not a member of this team.</p>
            )}
            <p className="mt-2 text-muted">Team admins manage the roster and routing settings.</p>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card className="mb-6" aria-labelledby="members-h">
            <CardHeader
              id="members-h"
              title="Members"
              description={`${data.members.filter((m) => m.status === "active").length} active of ${data.members.length}. Queue members are managed by Salesforce sync; pausing here is an admin override that sync keeps. Only manual members can be removed.${team.removal_policy === "reassign" ? " Pausing a member reassigns their upcoming bookings on this team." : ""}`}
            />
            <CardBody className="space-y-4">
              {team.membership_source === "salesforce_queue" ? (
                <p className="text-sm text-muted">
                  This roster mirrors the team&apos;s Salesforce Queues. To add people by hand, set the membership source to queue plus manual
                  {isAdmin ? (
                    <>
                      {" "}
                      under{" "}
                      <Link href={`/admin/teams/${team.id}/sync`} className="font-semibold text-primary underline">
                        Queue sync
                      </Link>
                    </>
                  ) : null}
                  .
                </p>
              ) : (
                <AddMemberForm action={addMemberAction.bind(null, team.id)} />
              )}
            </CardBody>
            {data.members.length === 0 ? (
              <EmptyState className="m-5" title="No members yet" />
            ) : (
              <Table caption="Team members">
                <THead>
                  <TR>
                    <TH>Member</TH>
                    <TH>Status</TH>
                    <TH>Source</TH>
                    <TH>Outlook</TH>
                    <TH className="text-right">Weight</TH>
                    <TH className="text-right">Tier</TH>
                    <TH className="text-right">Daily cap</TH>
                    <TH className="text-right">Assigned</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {data.members.map((m) => {
                    const cal = m.user_id ? (health.get(m.user_id) ?? "disconnected") : null;
                    const broken = cal !== null && cal !== "healthy";
                    const name = m.name ?? m.email;
                    return (
                      <TR key={m.id}>
                        <TD>
                          <div className="font-medium text-navy">{name}</div>
                          <div className="text-xs text-muted">{m.email}</div>
                        </TD>
                        <TD>
                          <StatusBadge status={m.status} />
                        </TD>
                        <TD>
                          <Badge tone={m.source === "queue" ? "primary" : "neutral"}>{m.source === "queue" ? "Queue" : "Manual"}</Badge>
                        </TD>
                        <TD>
                          {cal === null ? (
                            <span className="text-xs text-muted">Not signed in yet</span>
                          ) : (
                            <>
                              <StatusBadge status={cal} />
                              {broken ? <p className="mt-1 max-w-48 text-xs font-medium text-warning">Skipped by round-robin until reconnected</p> : null}
                            </>
                          )}
                        </TD>
                        <TD className="text-right tabular-nums">{m.weight}</TD>
                        <TD className="text-right tabular-nums">{m.priority_tier}</TD>
                        <TD className="text-right tabular-nums">{m.daily_cap ?? "—"}</TD>
                        <TD className="text-right tabular-nums">{m.rr_assignment_count}</TD>
                        <TD>
                          <div className="flex items-center justify-end gap-1">
                            <MemberEditDialog action={updateMemberAction.bind(null, team.id)} member={{ ...m, name }} />
                            <MemberStatusButton action={setMemberStatusAction.bind(null, team.id)} memberId={m.id} status={m.status} name={name} />
                            {m.source === "manual" ? <MemberRemoveButton action={removeMemberAction.bind(null, team.id)} memberId={m.id} name={name} /> : null}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </Card>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card aria-labelledby="settings-h">
              <CardHeader id="settings-h" title="Team settings" />
              <CardBody>
                <TeamSettingsForm
                  action={saveTeamSettingsAction.bind(null, team.id)}
                  initial={{ outlookConflictPolicy: team.outlook_conflict_policy, removalPolicy: team.removal_policy, massRemovalThresholdPct: team.mass_removal_threshold_pct }}
                />
              </CardBody>
            </Card>

            <Card aria-labelledby="admins-h">
              <CardHeader id="admins-h" title="Team admins" description="Team admins manage the roster, team event types and settings." />
              <CardBody className="space-y-4">
                {data.admins.length === 0 ? (
                  <p className="text-sm text-muted">No team admins. Global admins can always manage this team.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {data.admins.map((a) => (
                      <li key={a.user_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                        <span>
                          <span className="font-medium text-navy">{a.name}</span> <span className="text-muted">{a.email}</span>
                        </span>
                        {isAdmin ? (
                          <ActionButton action={removeTeamAdminAction.bind(null, team.id)} hidden={{ userId: a.user_id }} variant="ghost" size="sm" pendingLabel="Removing…">
                            Remove<span className="sr-only"> {a.name}</span>
                          </ActionButton>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {isAdmin ? <AddAdminForm action={addTeamAdminAction.bind(null, team.id)} /> : <p className="text-xs text-muted">Only global admins can change team admins.</p>}
              </CardBody>
            </Card>
          </div>

          <Card className="mb-6" aria-labelledby="dist-h">
            <CardHeader id="dist-h" title="Distribution" description="Bookings per primary host on this team's event types." />
            <CardBody className="space-y-4">
              <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end" aria-label="Distribution date range">
                <Input label="From" type="date" name="from" defaultValue={from.toISODate() ?? ""} />
                <Input label="To" type="date" name="to" defaultValue={to.toISODate() ?? ""} />
                <Button type="submit" variant="secondary">
                  Update
                </Button>
              </form>
              {data.distribution.length === 0 ? (
                <p className="text-sm text-muted">No bookings in this range.</p>
              ) : (
                <DistributionTable rows={data.distribution} />
              )}
            </CardBody>
          </Card>

          <Card aria-labelledby="log-h">
            <CardHeader id="log-h" title="Membership log" description="Latest 50 roster changes from Salesforce sync, admins and the system." />
            {data.events.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">No membership changes recorded yet.</p>
              </CardBody>
            ) : (
              <Table caption="Membership events">
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Member</TH>
                    <TH>Change</TH>
                    <TH>Source</TH>
                    <TH>By</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.events.map((e) => (
                    <TR key={e.id}>
                      <TD className="whitespace-nowrap">{formatDateTime(e.created_at, zone)}</TD>
                      <TD>{e.email}</TD>
                      <TD>
                        <span className="flex flex-wrap items-center gap-1">
                          {e.old_status ? <StatusBadge status={e.old_status} /> : <span className="text-muted">new</span>}
                          <span aria-hidden="true">→</span>
                          <span className="sr-only">to</span>
                          {e.new_status ? <StatusBadge status={e.new_status} /> : <span className="text-muted">removed</span>}
                        </span>
                      </TD>
                      <TD>
                        <Badge>{e.source}</Badge>
                      </TD>
                      <TD>{e.actor ?? <span className="text-muted">System</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function DistributionTable({ rows }: { rows: { user_id: string; name: string; booked: number; cancelled: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.booked));
  const total = rows.reduce((n, r) => n + r.booked, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <caption className="sr-only">Bookings per host. {total} bookings in total.</caption>
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="w-48 py-2 pr-4 text-left">
              Host
            </th>
            <th scope="col" className="py-2 pr-4 text-left">
              Bookings
            </th>
            <th scope="col" className="w-20 py-2 text-right">
              Share
            </th>
            <th scope="col" className="w-24 py-2 text-right">
              Cancelled
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user_id}>
              <th scope="row" className="py-2 pr-4 text-left font-medium text-navy">
                {r.name}
              </th>
              <td className="py-2 pr-4">
                <div className="flex items-center gap-3">
                  <div aria-hidden="true" className="h-3 flex-1 overflow-hidden rounded-full bg-surface-alt">
                    <div className="h-full rounded-full bg-gradient-to-r from-primary to-sky" style={{ width: `${(r.booked / max) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right tabular-nums">{r.booked}</span>
                </div>
              </td>
              <td className="py-2 text-right tabular-nums text-muted">{total ? Math.round((r.booked / total) * 100) : 0}%</td>
              <td className="py-2 text-right tabular-nums text-muted">{r.cancelled}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
