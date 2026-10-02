"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { brand } from "@/theme/brand";
import { cn } from "@/lib/cn";

type NavUser = { name: string; email: string; slug: string; role: "user" | "admin"; photoUrl: string | null };

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/bookings", label: "Bookings" },
  { href: "/event-types", label: "Event types" },
  { href: "/availability", label: "Availability" },
  { href: "/teams", label: "Teams" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function Avatar({ user }: { user: NavUser }) {
  return (
    <span aria-hidden="true" className="grid size-8 place-items-center overflow-hidden rounded-full bg-primary text-xs font-bold text-white">
      {user.photoUrl ? <Image src={user.photoUrl} alt="" width={32} height={32} unoptimized className="size-8 object-cover" /> : initials(user.name)}
    </span>
  );
}

/** Top navigation with a keyboard-accessible mobile disclosure and a user menu. */
export function AppNav({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const links = user.role === "admin" ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // Close menus on navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMobileOpen(false);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2" aria-label={`${brand.productName} dashboard`}>
          <Image src={brand.logo.light.src} alt="" width={brand.logo.light.width} height={brand.logo.light.height} className="h-9 w-auto" priority />
        </Link>

        <nav aria-label="Main" className="hidden flex-1 md:block">
          <ul className="flex items-center gap-1">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={isActive(l.href) ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-semibold transition-colors",
                    isActive(l.href) ? "bg-primary/10 text-primary" : "text-muted hover:bg-surface-alt hover:text-navy",
                  )}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative hidden md:block" ref={menuRef}>
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls="user-menu"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-full p-1 pr-3 text-sm font-medium text-navy hover:bg-surface-alt"
            >
              <Avatar user={user} />
              <span className="max-w-40 truncate">{user.name}</span>
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 text-muted" fill="currentColor">
                <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" />
              </svg>
              <span className="sr-only">Account menu</span>
            </button>
            {menuOpen ? (
              <div id="user-menu" className="absolute right-0 mt-2 w-64 rounded-brand border border-border bg-surface p-2 shadow-lg">
                <div className="border-b border-border px-3 pb-2 pt-1">
                  <p className="truncate text-sm font-semibold text-navy">{user.name}</p>
                  <p className="truncate text-xs text-muted">{user.email}</p>
                  {user.role === "admin" ? <p className="mt-1 text-xs font-semibold text-primary">Administrator</p> : null}
                </div>
                <Link href={`/${user.slug}`} className="mt-1 block rounded-md px-3 py-2 text-sm text-ink hover:bg-surface-alt" target="_blank" rel="noopener">
                  View my booking page
                </Link>
                <form action="/api/auth/logout" method="post">
                  <button type="submit" className="block w-full rounded-md px-3 py-2 text-left text-sm text-danger hover:bg-danger/5">
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-md text-navy hover:bg-surface-alt md:hidden"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileOpen((o) => !o)}
          >
            <span className="sr-only">{mobileOpen ? "Close menu" : "Open menu"}</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2">
              {mobileOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      <div id="mobile-nav" hidden={!mobileOpen} className="border-t border-border bg-surface md:hidden">
        <nav aria-label="Main mobile" className="px-4 py-3">
          <ul className="flex flex-col gap-1">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={isActive(l.href) ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-3 py-2.5 text-base font-semibold",
                    isActive(l.href) ? "bg-primary/10 text-primary" : "text-navy hover:bg-surface-alt",
                  )}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3 border-t border-border pt-3">
            <Avatar user={user} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-navy">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-danger hover:bg-danger/5">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </div>
    </header>
  );
}
