import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ children, className, as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article"; "aria-labelledby"?: string }) {
  return (
    <Tag className={cn("rounded-brand border border-border bg-surface shadow-sm", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, actions, id, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Card content area. `flush` removes the padding for edge-to-edge lists and tables. */
export function CardBody({ children, className, flush = false }: { children: ReactNode; className?: string; flush?: boolean }) {
  return <div className={cn(!flush && "px-5 py-4", className)}>{children}</div>;
}
