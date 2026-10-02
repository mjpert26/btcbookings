/** Turns a display name into a URL slug: "Mike Perticone" -> "mike-perticone". */
export function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "user";
}

// Paths that would collide with app routes at the root level.
export const RESERVED_SLUGS = new Set([
  "api", "admin", "dashboard", "login", "logout", "t", "b", "_next", "static", "public", "settings",
  "auth", "es", "en", "favicon-ico", "robots-txt", "sitemap-xml", "help", "support", "team", "teams",
  "book", "booking", "bookings", "embed", "health", "status",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
