import { OwnerListingPage } from "@/components/public/pages";

export const dynamic = "force-dynamic";

/** A user's listed event types. Unknown or inactive users get the shared 404. */
export default async function UserPage(props: PageProps<"/[userSlug]">) {
  const { userSlug } = await props.params;
  const { lang } = await props.searchParams;
  return <OwnerListingPage kind="user" ownerSlug={userSlug} lang={lang} />;
}
