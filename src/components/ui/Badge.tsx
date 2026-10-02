import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "navy";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-alt text-muted ring-border",
  primary: "bg-primary/10 text-primary ring-primary/25",
  success: "bg-success/10 text-success ring-success/25",
  warning: "bg-warning/10 text-warning ring-warning/30",
  danger: "bg-danger/10 text-danger ring-danger/25",
  navy: "bg-navy text-white ring-navy",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: BadgeTone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Maps common status values to a badge tone and readable label. */
const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  confirmed: { tone: "success", label: "Confirmed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  rescheduled: { tone: "primary", label: "Rescheduled" },
  flagged: { tone: "warning", label: "Flagged" },
  active: { tone: "success", label: "Active" },
  paused: { tone: "warning", label: "Paused" },
  pending_onboarding: { tone: "primary", label: "Pending onboarding" },
  healthy: { tone: "success", label: "Connected" },
  broken: { tone: "danger", label: "Needs reconnect" },
  disconnected: { tone: "danger", label: "Disconnected" },
  pending: { tone: "primary", label: "Pending" },
  running: { tone: "primary", label: "Running" },
  succeeded: { tone: "success", label: "Succeeded" },
  failed: { tone: "warning", label: "Failed" },
  dead: { tone: "danger", label: "Dead" },
  ok: { tone: "success", label: "OK" },
  unknown: { tone: "neutral", label: "Unknown" },
  bot_not_in_channel: { tone: "danger", label: "Bot not in channel" },
  error: { tone: "danger", label: "Error" },
  created: { tone: "success", label: "Created" },
  duplicate: { tone: "warning", label: "Duplicate" },
};

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const key = status ?? "unknown";
  const s = STATUS[key] ?? { tone: "neutral" as const, label: key.replace(/_/g, " ") };
  return (
    <Badge tone={s.tone} className={className}>
      {s.label}
    </Badge>
  );
}
