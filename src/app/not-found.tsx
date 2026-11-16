import type { Metadata } from "next";
import { PublicNotFound } from "@/components/public/pages";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Fallback for any URL no route matches. Most visitors who reach it are invitees with a
 * mistyped booking link, so it is the bilingual public page. Employees sign in at /login.
 */
export default function NotFound() {
  return <PublicNotFound />;
}
