import { EventBookingPage, eventMetadata } from "@/components/public/pages";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/t/[teamSlug]/[eventSlug]">) {
  const { teamSlug, eventSlug } = await props.params;
  return eventMetadata("team", teamSlug, eventSlug, "en");
}

export default async function TeamEventPage(props: PageProps<"/t/[teamSlug]/[eventSlug]">) {
  const { teamSlug, eventSlug } = await props.params;
  return <EventBookingPage kind="team" ownerSlug={teamSlug} eventSlug={eventSlug} language="en" />;
}
