"use client";

/*
 * Animated count-up number for dashboard statistics.
 * Written for this app in the style of the React Bits Pro "stats" blocks
 * (https://pro.reactbits.dev/docs/blocks/stats/stats-4), which animate figures into view.
 * Uses requestAnimationFrame with an ease-out curve and no dependencies.
 *
 * Accessibility: the final value is always the accessible text (the animated digits are
 * aria-hidden), and with prefers-reduced-motion the final value renders immediately.
 */

import { useEffect, useRef, useState } from "react";

export default function CountUp({ value, durationMs = 900, className }: { value: number; durationMs?: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || value === 0) return;
    let raf = 0;
    let startAt = 0;
    const tick = (now: number) => {
      if (!startAt) startAt = now;
      const p = Math.min(1, (now - startAt) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  const fmt = new Intl.NumberFormat("en-US");
  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{fmt.format(value)}</span>
      <span aria-hidden="true" className="tabular-nums">
        {fmt.format(shown)}
      </span>
    </span>
  );
}
