import { EventBookingPage, eventMetadata } from "@/components/public/pages";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/[userSlug]/[eventSlug]/es">) {
  const { userSlug, eventSlug } = await props.params;
  return eventMetadata("user", userSlug, eventSlug, "es");
}

/** Spanish variant of an individual event type (its own routing, inherited settings). */
export default async function UserEventPageEs(props: PageProps<"/[userSlug]/[eventSlug]/es">) {
  const { userSlug, eventSlug } = await props.params;
  return <EventBookingPage kind="user" ownerSlug={userSlug} eventSlug={eventSlug} language="es" />;
}
