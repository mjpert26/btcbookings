/*
 * Staggered Text.
 * Adapted from React Bits Pro "staggered-text-tw" (https://pro.reactbits.dev/docs/components/staggered-text).
 * The original animates with the motion library; this version uses one CSS keyframe
 * (btc-stagger-in in globals.css) with a per-segment delay, so it renders on the server and
 * needs no client JavaScript. prefers-reduced-motion shows the text immediately.
 */

import type { ElementType } from "react";
import { cn } from "@/lib/cn";

export interface StaggeredTextProps {
  text: string;
  as?: ElementType;
  className?: string;
  segmentClassName?: string;
  /** "words" (default) or "chars". */
  segmentBy?: "words" | "chars";
  /** Delay between segments in ms. */
  delay?: number;
  /** Delay before the first segment in ms. */
  startDelay?: number;
}

export default function StaggeredText({
  text,
  as: Tag = "span",
  className,
  segmentClassName,
  segmentBy = "words",
  delay = 80,
  startDelay = 0,
}: StaggeredTextProps) {
  const segments = segmentBy === "chars" ? Array.from(text) : text.split(" ");
  return (
    <Tag className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {segments.map((seg, i) => (
          <span
            key={`${i}-${seg}`}
            className={cn("btc-stagger-seg", segmentClassName)}
            style={{ animationDelay: `${startDelay + i * delay}ms` }}
          >
            {segmentBy === "chars" && seg === " " ? " " : seg}
            {segmentBy === "words" && i < segments.length - 1 ? " " : null}
          </span>
        ))}
      </span>
    </Tag>
  );
}
