import type { Metadata } from "next";
import { DateTime } from "luxon";
import { requireCapability } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { bookingsInsideBlocks, listTimeOff, timeOffZone, type OverlappingBooking } from "@/server/time-off";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { Button, ButtonLink } from "@/components/ui/Button";
import { TimeOffForm } from "@/components/app/TimeOff";
import { TimeOffList } from "@/components/app/TimeOffList";
import { can } from "@/lib/permissions";
import { formatRange } from "@/lib/format";
import { isUuid } from "@/server/ui/form";
import { adminAddTimeOffAction, adminDeleteTimeOffAction } from "../_actions/time-off";

export const metadata: Metadata = { title: "Time off" };

/**
 * Everyone's current and upcoming time off. Admins add and delete blocks for any active
 * user; managers read only. The admin layout already requires audit.read.
 */
export default async function AdminTimeOffPage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const viewer = await requireCapability("time_off.read_all");
  const manage = can(viewer.role, "time_off.manage_all");
  const raw = (await searchParams).user;
  const selected = typeof raw === "string" && isUuid(raw) ? raw : null;
  const now = new Date();

  const data = await withUser(viewer.id, async (tx) => {
    const users = await tx<{ id: string; name: string; email: string }[]>`
      select id, name, email from app.users where is_active order by name, email limit 1000
    `;
    // Notes are for the person and admins only; managers see the times.
    const blocks = (await listTimeOff(tx, { userId: selected, now })).map((b) => (manage ? b : { ...b, note: null }));
    const person = selected ? users.find((u) => u.id === selected) ?? null : null;
    const zone = person && manage ? await timeOffZone(tx, person.id) : null;
    let inside: Record<string, OverlappingBooking[]> = {};
    if (person && manage) inside = await bookingsInsideBlocks(tx, person.id, blocks, now);
    return { users, blocks, person, zone, inside };
  });

  const overlaps = Object.fromEntries(
    data.blocks.map((b) => [b.id, (data.inside[b.id] ?? []).map((x) => `${formatRange(x.startAt, x.endAt, b.timezone)} · ${x.inviteeName}`)]),
  );
  const minDate = data.zone ? DateTime.now().setZone(data.zone).toISODate() ?? "" : "";

  return (
    <>
      <PageHeader
        title="Time off"
        description={
          manage
            ? "Current and upcoming time off for everyone. A person on time off is unavailable on every booking page they host. Existing bookings are not changed."
            : "Read-only list of current and upcoming time off. A person on time off is unavailable on every booking page they host."
        }
      />
      <form method="get" className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end" aria-label="Filter time off by person">
        <Select
          label="Person"
          name="user"
          defaultValue={selected ?? ""}
          placeholder="Everyone"
          options={data.users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
          wrapperClassName="sm:w-96"
        />
        <div className="flex gap-2">
          <Button type="submit" variant="secondary">
            Show
          </Button>
          {selected ? (
            <ButtonLink href="/admin/time-off" variant="ghost">
              Everyone
            </ButtonLink>
          ) : null}
        </div>
      </form>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" aria-labelledby="time-off-list-h">
          <CardHeader id="time-off-list-h" title={data.person ? `Time off for ${data.person.name}` : "Time off"} />
          <CardBody>
            <TimeOffList
              blocks={data.blocks}
              showUser={!data.person}
              deleteAction={manage ? adminDeleteTimeOffAction : undefined}
              overlaps={overlaps}
              now={now}
              emptyDescription={data.person ? "This person has no current or upcoming time off." : "Nobody has current or upcoming time off."}
            />
          </CardBody>
        </Card>

        {manage ? (
          <Card aria-labelledby="time-off-add-h">
            <CardHeader id="time-off-add-h" title="Add time off" description={data.person ? `For ${data.person.name}.` : undefined} />
            <CardBody>
              {data.person && data.zone ? (
                <TimeOffForm key={data.person.id} action={adminAddTimeOffAction} minDate={minDate} timezone={data.zone} userId={data.person.id} />
              ) : (
                <p className="text-sm text-muted">Choose a person above to add time off for them. Dates and times are entered in that person&apos;s time zone.</p>
              )}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
