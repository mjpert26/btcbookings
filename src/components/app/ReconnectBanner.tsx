"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * Shown on every internal page when the user's Outlook connection is broken, disconnected
 * or missing. Reconnecting re-runs the Microsoft consent flow and returns to this page.
 */
export function ReconnectBanner({ status }: { status: "broken" | "disconnected" | "healthy" | null }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.size ? `?${search.toString()}` : "");
  const href = `/api/auth/login?reconnect=1&returnTo=${encodeURIComponent(current)}`;
  const heading =
    status === "broken"
      ? "Your Outlook connection needs attention"
      : status === "disconnected"
        ? "Your Outlook calendar is disconnected"
        : "Your Outlook calendar is not connected";

  return (
    <div role="alert" className="border-b border-warning/40 bg-[#fff7ed]">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-warning text-sm font-bold text-white">
            !
          </span>
          <div className="text-sm">
            <p className="font-semibold text-[#7c2d12]">{heading}</p>
            <p className="text-ink">
              New bookings cannot be written to your calendar, and round-robin teams skip you until you reconnect.
            </p>
          </div>
        </div>
        <a
          href={href}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-warning px-4 text-sm font-semibold text-white hover:bg-[#92400e]"
        >
          Reconnect Outlook
        </a>
      </div>
    </div>
  );
}
