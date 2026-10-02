import type { Metadata } from "next";
import { DateTime } from "luxon";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { DEFAULT_WEEKLY, normalizeWeekly } from "@/lib/availability";
import type { Interval } from "@/server/scheduling/types";
import { WeeklyEditor } from "./WeeklyEditor";
import { OverrideForm } from "./OverrideForm";
import { SettingsForm } from "./SettingsForm";
import { RemoveOverride } from "./RemoveOverride";

export const metadata: Metadata = { title: "Availability" };

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"];
  }
  if (!zones.includes(current)) zones = [current, ...zones];
  return zones;
}

export default async function AvailabilityPage() {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const [schedule] = await tx<{ id: string; timezone: string; weekly_rules: unknown }[]>`
      select id, timezone, weekly_rules from app.availability_schedules where owner_user_id = ${user.id} and is_default
    `;
    const overrides = schedule
      ? await tx<{ id: string; date: string; intervals: Interval[] }[]>`
          select id, to_char(date, 'YYYY-MM-DD') as date, intervals
          from app.availability_overrides
          where schedule_id = ${schedule.id} and date >= current_date - 1
          order by date
        `
      : [];
    const [settings] = await tx<
      { unavailable_show_as: string[]; daily_booking_cap: number | null; outlook_conflict_policy: string; notify_host_by_email: boolean }[]
    >`select unavailable_show_as, daily_booking_cap, outlook_conflict_policy, notify_host_by_email from app.user_settings where user_id = ${user.id}`;
    return { schedule, overrides, settings };
  });

  const tz = data.schedule?.timezone ?? user.timezone;
  const weekly = data.schedule ? normalizeWeekly(data.schedule.weekly_rules) : DEFAULT_WEEKLY;
  const today = DateTime.now().setZone(tz).toISODate() ?? "";

  return (
    <>
      <PageHeader title="Availability" description="Set the hours people can book you. Outlook busy time is always subtracted from these hours." />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" aria-labelledby="weekly-h">
          <CardHeader
            id="weekly-h"
            title="Weekly hours"
            description={data.schedule ? "Your default schedule, used by every event type unless it picks another schedule." : "You are using the standard template. Saving creates your own schedule."}
          />
          <CardBody>
            <WeeklyEditor initial={weekly} timezone={tz} zones={timeZones(tz)} />
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card aria-labelledby="overrides-h">
            <CardHeader id="overrides-h" title="Date overrides" description="Block a day off or set different hours for a specific date." />
            <CardBody className="space-y-5">
              {data.overrides.length === 0 ? (
                <EmptyState title="No overrides" description="Upcoming holidays or special hours will appear here." />
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {data.overrides.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="text-sm">
                        <p className="font-semibold text-navy">{DateTime.fromISO(o.date).toFormat("ccc, LLL d, yyyy")}</p>
                        <p className="text-muted">{o.intervals.length === 0 ? "Unavailable all day" : o.intervals.map((i) => `${i.start}–${i.end}`).join(", ")}</p>
                      </div>
                      <RemoveOverride id={o.id} label={o.date} />
                    </li>
                  ))}
                </ul>
              )}
              <OverrideForm minDate={today} />
            </CardBody>
          </Card>

          <Card aria-labelledby="prefs-h">
            <CardHeader id="prefs-h" title="Booking preferences" />
            <CardBody>
              <SettingsForm
                initial={{
                  unavailableShowAs: data.settings?.unavailable_show_as ?? ["busy", "tentative", "oof"],
                  dailyBookingCap: data.settings?.daily_booking_cap ?? null,
                  outlookConflictPolicy: data.settings?.outlook_conflict_policy ?? "flag",
                  notifyHostByEmail: data.settings?.notify_host_by_email ?? false,
                }}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
