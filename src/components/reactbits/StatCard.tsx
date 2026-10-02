/*
 * Statistic card.
 * Adapted from the stat cards in the React Bits Pro "stats-4" block
 * (https://pro.reactbits.dev/docs/blocks/stats/stats-4): dotted grid texture, large figure,
 * staggered fade-up entrance and a pulsing indicator for highlighted values. The motion
 * library animation is replaced with a CSS keyframe (btc-fade-up in globals.css), which
 * the global prefers-reduced-motion rule disables. Rendered on the server; only the
 * number is a client component.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import CountUp from "@/components/reactbits/CountUp";

export default function StatCard({
  label,
  value,
  suffix,
  hint,
  href,
  tone = "default",
  index = 0,
  icon,
}: {
  label: string;
  value: number;
  suffix?: string;
  hint?: ReactNode;
  href?: string;
  tone?: "default" | "highlight" | "warning";
  index?: number;
  icon?: ReactNode;
}) {
  const body = (
    <>
      <div aria-hidden="true" className="btc-dot-grid absolute inset-0" />
      <div className="relative flex h-full flex-col justify-between gap-4">
        <div className="flex items-center gap-2">
          {icon ? <span className="text-primary">{icon}</span> : null}
          <p className={cn("text-sm font-medium", tone === "warning" ? "text-warning" : "text-muted")}>{label}</p>
          {tone === "highlight" ? (
            <span aria-hidden="true" className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
          ) : null}
        </div>
        <div>
          <p className={cn("font-heading text-3xl font-bold tracking-tight sm:text-4xl", tone === "warning" ? "text-warning" : "text-navy")}>
            <CountUp value={value} />
            {suffix ? <span className="ml-1 text-lg font-semibold text-muted">{suffix}</span> : null}
          </p>
          {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
        </div>
      </div>
    </>
  );
  const cls = cn(
    "btc-fade-up group relative block min-h-32 overflow-hidden rounded-brand border border-border bg-surface p-4 shadow-sm sm:min-h-36 sm:p-5",
    href && "transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
  );
  const style = { animationDelay: `${index * 80}ms` };
  return href ? (
    <Link href={href} className={cls} style={style}>
      {body}
    </Link>
  ) : (
    <div className={cls} style={style}>
      {body}
    </div>
  );
}
