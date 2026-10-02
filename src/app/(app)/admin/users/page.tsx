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
import { setRoleAction } from "../_actions/users";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireAdmin();
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const { users, adminCount } = await withUser(user.id, async (tx) => {
    const users = await tx<{ id: string; name: string; email: string; role: string; is_active: boolean; last_login_at: Date | null; calendar: string | null; seeded: boolean }[]>`
      select u.id, u.name, u.email, u.role, u.is_active, u.last_login_at, cc.status as calendar,
             exists (select 1 from app.admin_seeds s where s.email = u.email) as seeded
      from app.users u left join app.calendar_connections cc on cc.user_id = u.id
      ${q ? tx`where u.name ilike ${like} or u.email ilike ${like}` : tx``}
      order by u.role desc, u.name
      limit 500
    `;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app.users where role = 'admin' and is_active`;
    return { users, adminCount: n };
  });

  return (
    <>
      <PageHeader title="Users" description="Everyone who has signed in. Role changes are audited; at least one admin must remain." />
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
                      {u.role === "admin" ? <Badge tone="navy">Admin</Badge> : <Badge>User</Badge>}
                      {!u.is_active ? <Badge tone="danger">Inactive</Badge> : null}
                      {u.seeded ? <Badge tone="primary" title="Promoted to admin on every sign-in">Seeded</Badge> : null}
                    </span>
                  </TD>
                  <TD>
                    <StatusBadge status={u.calendar ?? "disconnected"} />
                  </TD>
                  <TD>{formatRelative(u.last_login_at)}</TD>
                  <TD>
                    {u.role === "admin" ? (
                      lastAdmin ? (
                        <span className="text-xs text-muted">Last admin</span>
                      ) : (
                        <ActionButton action={setRoleAction} hidden={{ userId: u.id, role: "user" }} size="sm" pendingLabel="Saving…">
                          Make user<span className="sr-only"> {u.name}</span>
                        </ActionButton>
                      )
                    ) : (
                      <ActionButton action={setRoleAction} hidden={{ userId: u.id, role: "admin" }} size="sm" variant="subtle" pendingLabel="Saving…">
                        Make admin<span className="sr-only"> {u.name}</span>
                      </ActionButton>
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
