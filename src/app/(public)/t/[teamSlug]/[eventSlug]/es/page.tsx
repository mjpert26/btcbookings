import { EventBookingPage, eventMetadata } from "@/components/public/pages";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/t/[teamSlug]/[eventSlug]/es">) {
  const { teamSlug, eventSlug } = await props.params;
  return eventMetadata("team", teamSlug, eventSlug, "es");
}

/** Spanish variant of a team event type. Routes to the variant's own host pool. */
export default async function TeamEventPageEs(props: PageProps<"/t/[teamSlug]/[eventSlug]/es">) {
  const { teamSlug, eventSlug } = await props.params;
  return <EventBookingPage kind="team" ownerSlug={teamSlug} eventSlug={eventSlug} language="es" />;
}
