"use client";

/*
 * Spotlight tilt surface.
 * Adapted from React Bits Pro "depth-card-tw" (https://pro.reactbits.dev/docs/components/depth-card):
 * the same eased perspective tilt and cursor-following spotlight, applied to arbitrary
 * content instead of an image card. Tilt is subtle so forms stay easy to use, and it is
 * disabled for touch input and prefers-reduced-motion.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export default function SpotlightTilt({
  children,
  className,
  maxRotation = 4,
  spotlightColor = "rgba(34, 164, 220, 0.18)",
}: {
  children: ReactNode;
  className?: string;
  maxRotation?: number;
  spotlightColor?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const light = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = outer.current;
    if (!el || !inner.current || !light.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(hover: none)").matches) return;

    const target = { rx: 0, ry: 0 };
    const current = { rx: 0, ry: 0 };
    let raf = 0;
    const tick = () => {
      current.rx += (target.rx - current.rx) * 0.1;
      current.ry += (target.ry - current.ry) * 0.1;
      inner.current!.style.transform = `rotateX(${current.rx}deg) rotateY(${current.ry}deg)`;
      if (Math.abs(target.rx - current.rx) > 0.01 || Math.abs(target.ry - current.ry) > 0.01) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      target.rx = -py * maxRotation * 2;
      target.ry = px * maxRotation * 2;
      light.current!.style.opacity = "1";
      light.current!.style.background = `radial-gradient(520px circle at ${e.clientX - r.left}px ${e.clientY - r.top}px, ${spotlightColor}, transparent 60%)`;
      kick();
    };
    const onLeave = () => {
      target.rx = 0;
      target.ry = 0;
      light.current!.style.opacity = "0";
      kick();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [maxRotation, spotlightColor]);

  return (
    <div ref={outer} className={cn("[perspective:1200px]", className)}>
      <div ref={inner} className="relative h-full w-full rounded-[inherit] [transform-style:preserve-3d] will-change-transform">
        <div ref={light} aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] opacity-0 transition-opacity duration-300" />
        {children}
      </div>
    </div>
  );
}
