"use client";

/** Lazy wrapper: the aurora WebGL code loads after hydration; the CSS gradient shows until then. */
import dynamic from "next/dynamic";
import type { AuroraBlurProps } from "@/components/reactbits/AuroraBlur";

const AuroraBlur = dynamic(() => import("@/components/reactbits/AuroraBlur"), { ssr: false, loading: () => null });

export default function AuroraBackground(props: AuroraBlurProps) {
  return <AuroraBlur {...props} />;
}
