import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { isUuid } from "@/server/ui/form";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Notice } from "@/components/ui/Toast";
import { formatDateTime, formatRange, LOCATION_LABELS } from "@/lib/format";
import { pickLocalized } from "@/i18n/locales";
import { CancelBooking } from "./CancelBooking";

export const metadata: Metadata = { title: "Booking" };

type Booking = {
  id: string;
  event_type_id: string;
  event_type_name: string;
  language: string;
  status: string;
  start_at: Date;
  end_at: Date;
  invitee_name: string;
  invitee_email: string;
  invitee_phone: string | null;
  invitee_timezone: string;
  location_type: string;
  location_detail: string | null;
  online_meeting_url: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  flagged_reason: string | null;
  rescheduled_from_id: string | null;
  sf_lead_id: string | null;
  sf_lead_status: string | null;
  created_at: Date;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="text-sm text-ink sm:col-span-2">{children}</dd>
    </div>
  );
}

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const isAdmin = user.role === "admin";

  const data = await withUser(user.id, async (tx) => {
    const [b] = await tx<Booking[]>`
      select b.id, b.event_type_id, et.name as event_type_name, b.language, b.status, b.start_at, b.end_at,
             b.invitee_name, b.invitee_email, b.invitee_phone, b.invitee_timezone, b.location_type, b.location_detail,
             b.online_meeting_url, b.cancel_reason, b.cancelled_by, b.cancelled_at, b.flagged_reason,
             b.rescheduled_from_id, b.sf_lead_id, b.sf_lead_status, b.created_at
      from app.bookings b join app.event_types et on et.id = b.event_type_id
      where b.id = ${id}
    `;
    if (!b) return null;
    const hosts = await tx<{ user_id: string; name: string; email: string; role: string; active: boolean; has_event: boolean }[]>`
      select bh.user_id, u.name, u.email, bh.role, bh.active, (bh.graph_event_id is not null) as has_event
      from app.booking_hosts bh join app.users u on u.id = bh.user_id
      where bh.booking_id = ${id}
      order by bh.role, u.name
    `;
    const answers = await tx<{ question_key: string; value: string; label: Record<string, string> | null; position: number | null }[]>`
      select a.question_key, a.value, q.label, q.position
      from app.booking_answers a
      left join app.event_type_questions q on q.id = a.question_id
      where a.booking_id = ${id}
      order by q.position nulls last, a.question_key
    `;
    return { b, hosts, answers };
  });
  if (!data) notFound();
  const { b, hosts, answers } = data;
  const zone = user.timezone;
  const cancellable = (b.status === "confirmed" || b.status === "flagged") && new Date(b.end_at) > new Date();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ href: "/bookings", label: "Bookings" }]}
        title={b.invitee_name}
        description={`${b.event_type_name} · ${formatRange(b.start_at, b.end_at, zone)}`}
        actions={
          <>
            <StatusBadge status={b.status} />
            {cancellable ? <CancelBooking bookingId={b.id} inviteeName={b.invitee_name} /> : null}
          </>
        }
      />

      {b.status === "flagged" && b.flagged_reason ? (
        <Notice tone="warning" title="This booking is flagged" className="mb-6">
          {b.flagged_reason}
        </Notice>
      ) : null}
      {b.status === "cancelled" ? (
        <Notice tone="info" title="Cancelled" className="mb-6">
          Cancelled by {b.cancelled_by ?? "unknown"}
          {b.cancelled_at ? ` on ${formatDateTime(b.cancelled_at, zone)}` : ""}.{b.cancel_reason ? ` Reason: ${b.cancel_reason}` : ""}
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" aria-labelledby="details-h">
          <CardHeader id="details-h" title="Details" />
          <CardBody>
            <dl className="divide-y divide-border">
              <Row label="When (your time)">{formatRange(b.start_at, b.end_at, zone)}</Row>
              <Row label="Invitee's time zone">
                {b.invitee_timezone} ({formatRange(b.start_at, b.end_at, b.invitee_timezone)})
              </Row>
              <Row label="Email">
                <a className="text-primary underline" href={`mailto:${b.invitee_email}`}>
                  {b.invitee_email}
                </a>
              </Row>
              {b.invitee_phone ? <Row label="Phone">{b.invitee_phone}</Row> : null}
              <Row label="Location">
                {LOCATION_LABELS[b.location_type] ?? b.location_type}
                {b.location_detail ? ` · ${b.location_detail}` : ""}
                {b.online_meeting_url ? (
                  <>
                    {" · "}
                    <a href={b.online_meeting_url} className="text-primary underline" target="_blank" rel="noopener noreferrer">
                      Join link
                    </a>
                  </>
                ) : null}
              </Row>
              <Row label="Language">{b.language === "es" ? "Spanish" : b.language === "en" ? "English" : b.language}</Row>
              <Row label="Booked">{formatDateTime(b.created_at, zone)}</Row>
            </dl>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card aria-labelledby="hosts-h">
            <CardHeader id="hosts-h" title="Hosts and Outlook" />
            <CardBody flush>
              <ul className="divide-y divide-border">
                {hosts.map((h) => (
                  <li key={h.user_id} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-navy">{h.name}</span>
                      {h.role === "collective" ? <Badge>Collective</Badge> : <Badge tone="primary">Primary</Badge>}
                    </div>
                    <p className="mt-1 text-muted">
                      {!h.active ? "Removed from this booking" : h.has_event ? "Outlook event created" : "Outlook event pending"}
                    </p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {isAdmin ? (
            <Card aria-labelledby="sf-h">
              <CardHeader id="sf-h" title="Salesforce lead" description="Visible to admins only" />
              <CardBody className="space-y-1 text-sm">
                <p className="flex items-center gap-2">
                  Status: {b.sf_lead_status ? <StatusBadge status={b.sf_lead_status} /> : <span className="text-muted">Not requested</span>}
                </p>
                {b.sf_lead_id ? <p className="font-mono text-xs text-muted">Lead {b.sf_lead_id}</p> : null}
              </CardBody>
            </Card>
          ) : null}
        </div>

        <Card className="lg:col-span-2" aria-labelledby="answers-h">
          <CardHeader id="answers-h" title="Invitee answers" />
          <CardBody>
            {answers.length === 0 ? (
              <p className="text-sm text-muted">No additional questions were answered.</p>
            ) : (
              <dl className="divide-y divide-border">
                {answers.map((a) => (
                  <Row key={a.question_key} label={a.label ? pickLocalized(a.label, "en") : a.question_key}>
                    <span className="whitespace-pre-wrap">{a.value}</span>
                  </Row>
                ))}
              </dl>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
