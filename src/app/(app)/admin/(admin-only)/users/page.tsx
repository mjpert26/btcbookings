import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ActionButton } from "@/components/app/ActionButton";
import { formatRelative } from "@/lib/format";
import { decideLinkRequestAction, setRoleAction } from "../../_actions/users";
import { listPendingLinkRequests } from "@/server/auth/link-requests";
import { ROLE_LABEL } from "@/lib/permissions";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireAdmin();
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const { users, adminCount, linkRequests } = await withUser(user.id, async (tx) => {
    const users = await tx<{ id: string; name: string; email: string; role: string; is_active: boolean; last_login_at: Date | null; calendar: string | null; seeded: boolean }[]>`
      select u.id, u.name, u.email, u.role, u.is_active, u.last_login_at, cc.status as calendar,
             exists (select 1 from app.admin_seeds s where s.email = u.email) as seeded
      from app.users u left join app.calendar_connections cc on cc.user_id = u.id
      ${q ? tx`where u.name ilike ${like} or u.email ilike ${like}` : tx``}
      order by u.role desc, u.name
      limit 500
    `;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app.users where role = 'admin' and is_active`;
    const linkRequests = await listPendingLinkRequests(tx);
    return { users, adminCount: n, linkRequests };
  });

  return (
    <>
      <PageHeader title="Users" description="Everyone who has signed in or was added. Agents see their own bookings, managers read everything, admins manage everything. Role changes are audited; at least one admin must remain." />
      {linkRequests.length ? (
        <Card className="mb-6">
          <h2 className="text-base font-semibold text-navy">Sign-ins waiting for confirmation</h2>
          <p className="mt-1 text-sm text-muted">
            These people signed in with a Microsoft account whose name matches an account imported from Calendly, but whose email does not. Confirm only when the imported account belongs to the person who signed in. Rejecting gives them a new, empty account at their next sign-in.
          </p>
          <Table caption={`Pending confirmations (${linkRequests.length})`}>
            <THead>
              <TR>
                <TH>Signed in as</TH>
                <TH>Imported account</TH>
                <TH>Last attempt</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {linkRequests.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <div className="font-medium text-navy">{r.name}</div>
                    <div className="text-xs text-muted">{r.email}</div>
                  </TD>
                  <TD>
                    <div className="font-medium text-navy">{r.imported_name}</div>
                    <div className="text-xs text-muted">{r.imported_email}</div>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {r.imported_role !== "user" ? <Badge tone="navy">{ROLE_LABEL[r.imported_role as keyof typeof ROLE_LABEL] ?? r.imported_role}</Badge> : null}
                      {r.team_admin_of > 0 ? <Badge tone="primary">Team admin of {r.team_admin_of}</Badge> : null}
                    </span>
                  </TD>
                  <TD>
                    {formatRelative(r.last_requested_at)}
                    {r.attempts > 1 ? <span className="text-xs text-muted"> ({r.attempts} attempts)</span> : null}
                  </TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      <ActionButton action={decideLinkRequestAction} hidden={{ requestId: r.id, decision: "approve" }} size="sm" variant="subtle" pendingLabel="Saving…">
                        Confirm and link
                        <span className="sr-only"> {r.email}</span>
                      </ActionButton>
                      <ActionButton action={decideLinkRequestAction} hidden={{ requestId: r.id, decision: "reject" }} size="sm" variant="secondary" pendingLabel="Saving…">
                        Not the same person
                        <span className="sr-only"> {r.email}</span>
                      </ActionButton>
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}
      <form method="get" className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end" aria-label="Search users">
        <Input label="Search" name="q" defaultValue={q} placeholder="Name or email" wrapperClassName="sm:w-80" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <Card>
        <Table caption={`Users (${users.length})`}>
          <THead>
            <TR>
              <TH>User</TH>
              <TH>Role</TH>
              <TH>Outlook</TH>
              <TH>Last sign-in</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {users.map((u) => {
              const lastAdmin = u.role === "admin" && adminCount <= 1;
              return (
                <TR key={u.id}>
                  <TD>
                    <div className="font-medium text-navy">
                      {u.name} {u.id === user.id ? <span className="text-xs font-normal text-muted">(you)</span> : null}
                    </div>
                    <div className="text-xs text-muted">{u.email}</div>
                  </TD>
                  <TD>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={u.role === "admin" ? "navy" : u.role === "manager" ? "primary" : "neutral"}>{ROLE_LABEL[u.role as keyof typeof ROLE_LABEL] ?? u.role}</Badge>
                      {!u.is_active ? <Badge tone="danger">Inactive</Badge> : null}
                      {u.seeded ? <Badge tone="primary" title="Promoted to admin on every sign-in">Seeded</Badge> : null}
                    </span>
                  </TD>
                  <TD>
                    <StatusBadge status={u.calendar ?? "disconnected"} />
                  </TD>
                  <TD>{formatRelative(u.last_login_at)}</TD>
                  <TD>
                    {lastAdmin ? (
                      <span className="text-xs text-muted">Last admin</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {(["user", "manager", "admin"] as const)
                          .filter((r) => r !== u.role)
                          .map((r) => (
                            <ActionButton key={r} action={setRoleAction} hidden={{ userId: u.id, role: r }} size="sm" variant={r === "admin" ? "subtle" : "secondary"} pendingLabel="Saving…">
                              Make {ROLE_LABEL[r].toLowerCase()}
                              <span className="sr-only"> {u.name}</span>
                            </ActionButton>
                          ))}
                      </span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
      <p className="mt-3 text-xs text-muted">Demoting a seeded admin removes their seed. Emails listed in the ADMIN_EMAILS setting are promoted again at their next sign-in.</p>
    </>
  );
}
