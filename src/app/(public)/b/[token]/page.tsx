import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingPage } from "@/components/public/BookingPage";
import { tokenSchema } from "@/server/booking/validation";

export const dynamic = "force-dynamic";

// Token pages are never indexed and never leak the token through the Referer header.
export const metadata: Metadata = {
  title: "Booking",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ManageBookingPage(props: PageProps<"/b/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  if (!tokenSchema.safeParse(token).success) notFound();
  return <BookingPage token={token} isNew={sp.new === "1"} updated={sp.updated === "1"} />;
}
