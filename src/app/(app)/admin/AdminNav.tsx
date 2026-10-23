"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { can, type Capability, type Role } from "@/lib/permissions";

/** Items without a capability are for global admins only. */
const ITEMS: { href: string; label: string; exact?: boolean; capability?: Capability }[] = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/salesforce/lead-routing", label: "Lead routing (ISO)" },
  { href: "/admin/salesforce/jobs", label: "Salesforce jobs" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/import", label: "Import" },
  { href: "/admin/audit", label: "Audit log", capability: "audit.read" },
  { href: "/admin/errors", label: "Errors" },
];

export function AdminNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => (i.capability ? can(role, i.capability) : role === "admin"));
  return (
    <nav aria-label="Admin" className="mb-6 -mt-2 overflow-x-auto">
      <ul className="flex gap-1 rounded-brand border border-border bg-surface p-1 shadow-sm sm:inline-flex">
        {items.map((i) => {
          const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={cn("block whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold", active ? "bg-navy text-white" : "text-muted hover:bg-surface-alt hover:text-navy")}
              >
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
