import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Responsive data table. Scrolls horizontally on narrow screens; the caption names it for screen readers. */
export function Table({ caption, children, className, captionVisible = false }: { caption: string; children: ReactNode; className?: string; captionVisible?: boolean }) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption className={cn(captionVisible ? "pb-2 text-left text-sm font-semibold text-navy" : "sr-only")}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border bg-surface-alt text-xs uppercase tracking-wide text-muted">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function TR({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("align-top hover:bg-surface-alt/60", className)} {...props} />;
}

export function TH({ className, scope = "col", ...props }: ComponentProps<"th">) {
  return <th scope={scope} className={cn("px-4 py-2.5 font-semibold", className)} {...props} />;
}

export function TD({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 text-ink", className)} {...props} />;
}
