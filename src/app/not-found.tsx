import type { Metadata } from "next";
import { PublicNotFound } from "@/components/public/pages";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Fallback for any URL no route matches. Most visitors who reach it are invitees with a
 * mistyped booking link, so it is the bilingual public page with a link for employees.
 */
export default function NotFound() {
  return <PublicNotFound employeeLink />;
}
