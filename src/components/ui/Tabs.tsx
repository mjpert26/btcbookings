import Link from "next/link";
import { cn } from "@/lib/cn";

export type TabLink = { href: string; label: string; active: boolean; count?: number };

/**
 * URL-driven tabs. Each tab is a link so the selection survives reloads and is shareable;
 * the active tab carries aria-current="page".
 */
export function LinkTabs({ tabs, label }: { tabs: TabLink[]; label: string }) {
  return (
    <nav aria-label={label} className="mb-4 border-b border-border">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              aria-current={t.active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
                t.active ? "border-primary text-primary" : "border-transparent text-muted hover:border-border hover:text-navy",
              )}
            >
              {t.label}
              {t.count !== undefined ? (
                <span className={cn("rounded-full px-1.5 text-xs", t.active ? "bg-primary/10" : "bg-surface-alt")}>{t.count}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
