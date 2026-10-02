import { EventBookingPage, eventMetadata } from "@/components/public/pages";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/[userSlug]/[eventSlug]">) {
  const { userSlug, eventSlug } = await props.params;
  return eventMetadata("user", userSlug, eventSlug, "en");
}

export default async function UserEventPage(props: PageProps<"/[userSlug]/[eventSlug]">) {
  const { userSlug, eventSlug } = await props.params;
  return <EventBookingPage kind="user" ownerSlug={userSlug} eventSlug={eventSlug} language="en" />;
}
