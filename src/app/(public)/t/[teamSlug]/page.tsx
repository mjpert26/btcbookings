import { OwnerListingPage, teamListingMetadata } from "@/components/public/pages";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/t/[teamSlug]">) {
  const { teamSlug } = await props.params;
  return teamListingMetadata(teamSlug);
}

/** A team's listed event types. Members are never listed. */
export default async function TeamPage(props: PageProps<"/t/[teamSlug]">) {
  const { teamSlug } = await props.params;
  const { lang } = await props.searchParams;
  return <OwnerListingPage kind="team" ownerSlug={teamSlug} lang={lang} />;
}
