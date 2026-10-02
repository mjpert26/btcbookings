/** Small presentational pieces shared by public server and client components. */

export function Avatar({ name, photoUrl, size = 56, alt }: { name: string; photoUrl: string | null; size?: number; alt: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  if (photoUrl) {
    return (
      // Host photos come from storage URLs that are not known at build time.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={photoUrl} alt={alt} width={size} height={size} className="rounded-full border border-border object-cover" style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded-full bg-navy font-semibold text-white"
      style={{ width: size, height: size, fontSize: size / 2.6 }}
    >
      {initials || "•"}
    </span>
  );
}

export function IconClock() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 6v4l2.5 2" strokeLinecap="round" />
    </svg>
  );
}

export function IconLocation({ type }: { type: "teams" | "phone" | "in_person" | "custom" }) {
  if (type === "teams") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2.5" y="5" width="10" height="10" rx="2" />
        <path d="M12.5 8.5l5-2.5v8l-5-2.5" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === "phone") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M5 3h3l1.5 4-2 1.2a9 9 0 004.3 4.3L13 10.5l4 1.5v3a2 2 0 01-2 2A13 13 0 013 5a2 2 0 012-2z" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 18s6-5.2 6-10a6 6 0 10-12 0c0 4.8 6 10 6 10z" />
      <circle cx="10" cy="8" r="2" />
    </svg>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-brand border border-border bg-white shadow-[0_1px_2px_rgba(11,61,102,0.06)] ${className}`}>{children}</div>;
}
