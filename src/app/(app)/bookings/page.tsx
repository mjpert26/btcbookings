import type { Metadata } from "next";
import Link from "next/link";
import { DateTime } from "luxon";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkTabs } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Select } from "@/components/ui/Field";
import { Button, ButtonLink } from "@/components/ui/Button";
import { formatDate, formatTime } from "@/lib/format";

export const metadata: Metadata = { title: "Bookings" };

const STATUSES = ["confirmed", "flagged", "cancelled", "rescheduled"] as const;
const PAGE_SIZE = 50;

const filterSchema = z.object({
  tab: z.enum(["upcoming", "past"]).catch("upcoming"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  eventType: z.string().uuid().optional().catch(undefined),
  status: z.enum(STATUSES).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});

type Row = {
  id: string;
  start_at: Date;
  end_at: Date;
  status: string;
  invitee_name: string;
  invitee_email: string;
  event_type_name: string;
  language: string;
  hosts: string | null;
};

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const raw = await searchParams;
  const f = filterSchema.parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v || undefined])));

  const zone = user.timezone;
  const fromAt = f.from ? DateTime.fromISO(f.from, { zone }).startOf("day").toJSDate() : null;
  const toAt = f.to ? DateTime.fromISO(f.to, { zone }).plus({ days: 1 }).startOf("day").toJSDate() : null;
  const upcoming = f.tab === "upcoming";

  const { rows, eventTypes, total } = await withUser(user.id, async (tx) => {
    const where = tx`
      where ${upcoming ? tx`b.end_at >= now()` : tx`b.end_at < now()`}
        ${fromAt ? tx`and b.start_at >= ${fromAt}` : tx``}
        ${toAt ? tx`and b.start_at < ${toAt}` : tx``}
        ${f.eventType ? tx`and b.event_type_id = ${f.eventType}` : tx``}
        ${f.status ? tx`and b.status = ${f.status}` : tx``}
    `;
    const rows = await tx<Row[]>`
      select b.id, b.start_at, b.end_at, b.status, b.invitee_name, b.invitee_email, b.language,
             et.name as event_type_name,
             (select string_agg(u.name, ', ' order by bh.role, u.name)
                from app.booking_hosts bh join app.users u on u.id = bh.user_id
                where bh.booking_id = b.id) as hosts
      from app.bookings b
      join app.event_types et on et.id = b.event_type_id
      ${where}
      order by b.start_at ${upcoming ? tx`asc` : tx`desc`}
      limit ${PAGE_SIZE} offset ${(f.page - 1) * PAGE_SIZE}
    `;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app.bookings b ${where}`;
    const eventTypes = await tx<{ id: string; name: string; language: string }[]>`
      select id, name, language from app.event_types order by name, language
    `;
    return { rows, eventTypes, total: n };
  });

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { tab: f.tab, from: f.from, to: f.to, eventType: f.eventType, status: f.status, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/bookings?${p.toString()}`;
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Bookings" description="Meetings you host, plus bookings on event types and teams you manage." />
      <LinkTabs
        label="Booking time frame"
        tabs={[
          { href: qs({ tab: "upcoming", page: undefined }), label: "Upcoming", active: upcoming },
          { href: qs({ tab: "past", page: undefined }), label: "Past", active: !upcoming },
        ]}
      />

      <form method="get" action="/bookings" className="mb-4 grid grid-cols-1 gap-3 rounded-brand border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" aria-label="Filter bookings">
        <input type="hidden" name="tab" value={f.tab} />
        <Input label="From" type="date" name="from" defaultValue={f.from} />
        <Input label="To" type="date" name="to" defaultValue={f.to} />
        <Select
          label="Event type"
          name="eventType"
          defaultValue={f.eventType ?? ""}
          placeholder="All event types"
          options={eventTypes.map((e) => ({ value: e.id, label: `${e.name}${e.language !== "en" ? ` (${e.language.toUpperCase()})` : ""}` }))}
        />
        <Select
          label="Status"
          name="status"
          defaultValue={f.status ?? ""}
          placeholder="Any status"
          options={STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))}
        />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            Apply
          </Button>
          <ButtonLink href={`/bookings?tab=${f.tab}`} variant="secondary">
            Reset
          </ButtonLink>
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={upcoming ? "No upcoming bookings" : "No past bookings"} description="Try changing the filters, or share your booking page." />
      ) : (
        <Card>
          <Table caption={`${upcoming ? "Upcoming" : "Past"} bookings, ${total} total`}>
            <THead>
              <TR>
                <TH>When ({DateTime.now().setZone(zone).toFormat("ZZZZ")})</TH>
                <TH>Invitee</TH>
                <TH>Event type</TH>
                <TH>Host</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((b) => (
                <TR key={b.id}>
                  <TD className="whitespace-nowrap">
                    <Link href={`/bookings/${b.id}`} className="font-semibold text-primary hover:underline">
                      {formatDate(b.start_at, zone)}
                    </Link>
                    <div className="text-muted">
                      {formatTime(b.start_at, zone)} – {formatTime(b.end_at, zone)}
                    </div>
                  </TD>
                  <TD>
                    <div className="font-medium text-navy">{b.invitee_name}</div>
                    <div className="text-muted">{b.invitee_email}</div>
                  </TD>
                  <TD>
                    {b.event_type_name}
                    {b.language !== "en" ? <span className="ml-1 text-xs font-semibold text-muted">({b.language.toUpperCase()})</span> : null}
                  </TD>
                  <TD>{b.hosts ?? "—"}</TD>
                  <TD>
                    <StatusBadge status={b.status} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {pages > 1 ? (
            <nav aria-label="Pagination" className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
              <span className="text-muted">
                Page {f.page} of {pages}
              </span>
              <span className="flex gap-2">
                {f.page > 1 ? (
                  <ButtonLink href={qs({ page: String(f.page - 1) })} variant="secondary" size="sm">
                    Previous
                  </ButtonLink>
                ) : null}
                {f.page < pages ? (
                  <ButtonLink href={qs({ page: String(f.page + 1) })} variant="secondary" size="sm">
                    Next
                  </ButtonLink>
                ) : null}
              </span>
            </nav>
          ) : null}
        </Card>
      )}
    </>
  );
}
