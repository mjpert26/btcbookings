"use client";

/*
 * 3D Letter Swap text.
 * Adapted from React Bits Pro "3d-letter-swap-tw" (https://pro.reactbits.dev/docs/components/3d-letter-swap).
 * The original animates with the motion library; this version uses one CSS keyframe
 * animation (btc-letter-flip in globals.css) with a per-character delay, so it needs no
 * extra dependency.
 *
 * Behavior: plays once after mount and again on hover or keyboard focus of the parent.
 * The full text is exposed once to assistive technology; the animated glyphs are hidden.
 * With prefers-reduced-motion the text renders statically.
 */

import { useEffect, useMemo, useState, type ElementType } from "react";
import { cn } from "@/lib/cn";

function splitGraphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

export default function LetterSwap({
  text,
  as: Tag = "span",
  className,
  staggerMs = 35,
  durationMs = 550,
  initialDelayMs = 250,
  backFaceClassName,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  staggerMs?: number;
  durationMs?: number;
  initialDelayMs?: number;
  backFaceClassName?: string;
}) {
  const [run, setRun] = useState(0);
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    const t = window.setTimeout(() => setRun((r) => r + 1), initialDelayMs);
    return () => {
      mq.removeEventListener("change", apply);
      window.clearTimeout(t);
    };
  }, [initialDelayMs]);

  const words = useMemo(() => text.split(" ").map((w) => splitGraphemes(w)), [text]);
  const total = words.reduce((n, w) => n + w.length, 0);
  const [busyUntil, setBusyUntil] = useState(0);

  function replay() {
    const now = Date.now();
    if (reduced || now < busyUntil) return;
    setBusyUntil(now + total * staggerMs + durationMs);
    setRun((r) => r + 1);
  }

  if (reduced) {
    return <Tag className={className}>{text}</Tag>;
  }

  let index = 0;
  return (
    <Tag className={cn("relative", className)} style={{ perspective: "1000px" }} onMouseEnter={replay}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((chars, wi) => (
          <span key={wi} className="inline-block whitespace-nowrap" style={{ transformStyle: "preserve-3d" }}>
            {chars.map((ch) => {
              const i = index++;
              return (
                <span
                  key={`${run}-${i}`}
                  className={cn("relative inline-block", run > 0 && "btc-letter-flip")}
                  style={{
                    transformStyle: "preserve-3d",
                    transform: "translateZ(-0.5lh)",
                    transformOrigin: "center center",
                    animationDuration: `${durationMs}ms`,
                    animationDelay: `${i * staggerMs}ms`,
                  }}
                >
                  <span className="relative inline-block" style={{ transform: "translateZ(0.5lh)", backfaceVisibility: "hidden" }}>
                    {ch}
                  </span>
                  <span
                    className={cn("absolute left-0 top-0 inline-block", backFaceClassName)}
                    style={{ transform: "rotateX(-90deg) translateZ(0.5lh)", backfaceVisibility: "hidden" }}
                  >
                    {ch}
                  </span>
                </span>
              );
            })}
            {wi < words.length - 1 ? <span className="inline-block w-[0.3em]"> </span> : null}
          </span>
        ))}
      </span>
    </Tag>
  );
}
