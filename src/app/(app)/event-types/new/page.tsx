import type { Metadata } from "next";
import { requireUser } from "@/server/auth/session";
import { withUser } from "@/server/db/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { EventTypeForm } from "../EventTypeForm";
import { createEventTypeAction } from "../_actions";
import { manageableTeams, scheduleOptions } from "../_data";
import { NEW_EVENT_TYPE } from "../_values";

export const metadata: Metadata = { title: "New event type" };

export default async function NewEventTypePage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const { teams, schedules } = await withUser(user.id, async (tx) => ({
    teams: await manageableTeams(tx),
    schedules: await scheduleOptions(tx, null),
  }));
  const ownerOptions = [{ value: "me", label: `Me (${user.name})` }, ...teams.map((t) => ({ value: t.id, label: `Team: ${t.name}` }))];
  const defaultOwner = sp.team && teams.some((t) => t.id === sp.team) ? sp.team : "me";

  return (
    <>
      <PageHeader breadcrumbs={[{ href: "/event-types", label: "Event types" }]} title="New event type" description="Create a booking page people can schedule with." />
      <EventTypeForm
        action={createEventTypeAction}
        values={NEW_EVENT_TYPE}
        mode="create"
        ownerOptions={ownerOptions}
        defaultOwner={defaultOwner}
        isTeam={false}
        schedules={schedules.map((s) => ({ value: s.id, label: s.owner ? `${s.name} (${s.owner})` : s.name }))}
      />
    </>
  );
}
