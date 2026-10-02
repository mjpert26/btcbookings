"use client";

/*
 * Lazy wrapper for the React Bits "silk-waves" adaptation. The WebGL code is loaded only
 * in the browser after hydration so it never blocks first paint; until then the parent's
 * CSS gradient shows through.
 */

import dynamic from "next/dynamic";
import type { SilkWavesProps } from "@/components/reactbits/SilkWaves";

const SilkWaves = dynamic(() => import("@/components/reactbits/SilkWaves"), { ssr: false, loading: () => null });

export default function SilkBackground(props: SilkWavesProps) {
  return <SilkWaves {...props} />;
}
