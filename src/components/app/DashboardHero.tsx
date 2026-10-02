import Link from "next/link";
import { DateTime } from "luxon";
import AuroraBackground from "@/components/reactbits/AuroraBackground";
import { BTC_AURORA_BANNER } from "@/components/reactbits/aurora-presets";
import StaggeredText from "@/components/reactbits/StaggeredText";

/**
 * Branded welcome banner for the dashboard: the React Bits aurora (BTC palette) behind a
 * time-of-day greeting. The CSS gradient shows until WebGL loads or when it is unavailable.
 */
export function DashboardHero({
  firstName,
  timezone,
  upcomingCount,
  publicUrl,
}: {
  firstName: string;
  timezone: string;
  upcomingCount: number;
  publicUrl: string;
}) {
  const now = DateTime.now().setZone(timezone);
  const greeting = now.hour < 12 ? "Good morning" : now.hour < 17 ? "Good afternoon" : "Good evening";
  const summary =
    upcomingCount === 0
      ? "No meetings in the next 7 days. Share your booking page to fill your calendar."
      : `You have ${upcomingCount} ${upcomingCount === 1 ? "meeting" : "meetings"} in the next 7 days.`;

  return (
    <section
      aria-labelledby="dashboard-greeting"
      className="relative isolate mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-[#0b4f84] to-primary px-6 py-8 text-white shadow-lg shadow-navy/20 sm:px-8 sm:py-10"
    >
      <div className="absolute inset-0 -z-10 opacity-90">
        <AuroraBackground speed={0.7} {...BTC_AURORA_BANNER} />
      </div>
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-navy/60 via-transparent to-transparent" />
      <p className="btc-fade-up text-sm font-medium text-sky">{now.toFormat("cccc, LLLL d")}</p>
      <h1 id="dashboard-greeting" className="mt-1 font-heading text-3xl font-extrabold text-white sm:text-4xl">
        <StaggeredText text={`${greeting}, ${firstName}.`} delay={90} />
      </h1>
      <p className="btc-fade-up mt-2 max-w-xl text-white/85 [animation-delay:400ms]">{summary}</p>
      <div className="btc-fade-up mt-6 flex flex-wrap gap-3 [animation-delay:550ms]">
        <Link
          href="/event-types/new"
          className="inline-flex h-10 items-center rounded-lg bg-white px-4 text-sm font-semibold text-navy shadow-sm transition hover:bg-white/90"
        >
          New event type
        </Link>
        <Link
          href="/bookings"
          className="inline-flex h-10 items-center rounded-lg border border-white/30 bg-white/10 px-4 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"
        >
          View all bookings
        </Link>
        <a
          href={publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-white underline-offset-4 hover:underline"
        >
          Open my booking page
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
            <path fillRule="evenodd" d="M5.22 14.78a.75.75 0 0 0 1.06 0l7.22-7.22v5.69a.75.75 0 0 0 1.5 0v-7.5a.75.75 0 0 0-.75-.75h-7.5a.75.75 0 0 0 0 1.5h5.69l-7.22 7.22a.75.75 0 0 0 0 1.06Z" clipRule="evenodd" />
          </svg>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
    </section>
  );
}
