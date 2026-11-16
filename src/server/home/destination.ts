import "server-only";
import type { Db } from "@/server/db/client";
import type { Locale } from "@/i18n/locales";
import { eventPath, loadEventTypeById, loadPool } from "@/server/booking/load";
import { DEFAULT_EXCLUDED_OWNER_EMAILS, DEFAULT_PAGE_SLUGS } from "@/lib/home-routing";
import type { RouteDecision } from "@/server/home/decide";

/**
 * Turns a routing decision into a booking page path. Runs on the service connection for the
 * public lookup (RLS bypassed), so every query selects only the columns it needs, and only a
 * relative path leaves this module for the browser.
 */

export type HomeRoutingConfig = {
  newBusinessEventTypeId: string | null;
  renewalDefaultEventTypeId: string | null;
  /** Salesforce renewal book name -> event type id. */
  renewalBooks: Record<string, string>;
  excludedOwnerEmails: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps only string keys mapped to event type ids. */
export function parseRenewalBooks(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [book, id] of Object.entries(raw as Record<string, unknown>)) {
    if (book.trim() && typeof id === "string" && UUID_RE.test(id)) out[book.trim()] = id;
  }
  return out;
}

/** The routing configuration. A missing row means nothing is configured and the default exclusions apply. */
export async function readHomeRouting(db: Db): Promise<HomeRoutingConfig> {
  const [row] = await db<
    { new_business_event_type_id: string | null; renewal_default_event_type_id: string | null; renewal_books: unknown; excluded_owner_emails: string[] }[]
  >`
    select new_business_event_type_id, renewal_default_event_type_id, renewal_books, excluded_owner_emails
    from app.home_routing where id
  `;
  if (!row) {
    return { newBusinessEventTypeId: null, renewalDefaultEventTypeId: null, renewalBooks: {}, excludedOwnerEmails: [...DEFAULT_EXCLUDED_OWNER_EMAILS] };
  }
  return {
    newBusinessEventTypeId: row.new_business_event_type_id,
    renewalDefaultEventTypeId: row.renewal_default_event_type_id,
    renewalBooks: parseRenewalBooks(row.renewal_books),
    excludedOwnerEmails: row.excluded_owner_emails.map((e) => String(e).toLowerCase()),
  };
}

type EventRow = {
  id: string;
  owner_user_id: string | null;
  team_id: string | null;
  slug: string;
  language: string;
  parent_event_type_id: string | null;
  is_active: boolean;
};

async function ownerOf(db: Db, row: EventRow): Promise<{ kind: "user" | "team"; slug: string } | null> {
  if (row.owner_user_id) {
    const [u] = await db<{ slug: string }[]>`select slug from app.users where id = ${row.owner_user_id} and is_active`;
    return u ? { kind: "user", slug: u.slug } : null;
  }
  if (row.team_id) {
    const [t] = await db<{ slug: string }[]>`select slug from app.teams where id = ${row.team_id}`;
    return t ? { kind: "team", slug: t.slug } : null;
  }
  return null;
}

/**
 * The public path of an active event type, in the visitor's language when an active variant
 * in that language exists (the variant with the same slug first), else the event type itself.
 * Null when the event type is missing or inactive, or its owner is not active.
 */
export async function eventTypePath(db: Db, eventTypeId: string, locale: Locale): Promise<string | null> {
  if (!UUID_RE.test(eventTypeId)) return null;
  const [row] = await db<EventRow[]>`
    select id, owner_user_id, team_id, slug, language, parent_event_type_id, is_active
    from app.event_types where id = ${eventTypeId}
  `;
  if (!row || !row.is_active) return null;
  const owner = await ownerOf(db, row);
  if (!owner) return null;
  if (row.language !== locale) {
    const root = row.parent_event_type_id ?? row.id;
    const [alt] = await db<{ slug: string; language: string }[]>`
      select slug, language from app.event_types
      where is_active and language = ${locale} and (id = ${root} or parent_event_type_id = ${root})
      order by (slug = ${row.slug}) desc, slug
      limit 1
    `;
    if (alt) return eventPath(owner.kind, owner.slug, alt.slug, alt.language);
  }
  return eventPath(owner.kind, owner.slug, row.slug, row.language);
}

/** An active app user with this email (case-insensitive) and a healthy calendar connection. */
export async function bookableUserByEmail(db: Db, email: string): Promise<{ id: string; email: string } | null> {
  if (!email || email.length > 254) return null;
  const [u] = await db<{ id: string; email: string }[]>`
    select u.id, u.email::text as email
    from app.users u
    join app.calendar_connections cc on cc.user_id = u.id
    where u.email = ${email} and u.is_active and cc.status = 'healthy'
  `;
  return u ?? null;
}

/**
 * A user's default personal booking page: an active, listed personal event type (not a
 * variant), preferring the slugs in DEFAULT_PAGE_SLUGS in order, else the only one. Returns the
 * path in the visitor's language when possible, or null.
 */
export async function personalDefaultPage(db: Db, userId: string, locale: Locale): Promise<string | null> {
  const rows = await db<{ id: string; slug: string; language: string }[]>`
    select id, slug, language from app.event_types
    where owner_user_id = ${userId} and team_id is null and parent_event_type_id is null and is_active and is_listed
    order by slug, language
  `;
  let pick: { id: string } | undefined;
  for (const slug of DEFAULT_PAGE_SLUGS) {
    const matches = rows.filter((r) => r.slug === slug);
    pick = matches.find((r) => r.language === locale) ?? matches[0];
    if (pick) break;
  }
  if (!pick && rows.length === 1) pick = rows[0];
  return pick ? eventTypePath(db, pick.id, locale) : null;
}

/** Whether the user is an eligible host (active member, healthy calendar) of the event type. */
export async function isEligibleHost(db: Db, eventTypeId: string, userId: string): Promise<boolean> {
  const loaded = await loadEventTypeById(db, eventTypeId);
  if (!loaded || !loaded.active) return false;
  const pool = await loadPool(db, loaded);
  return pool.some((h) => h.userId === userId && h.eligible);
}

/** The new-business (next available advisor) page, when configured and active. */
export async function newBusinessPath(db: Db, config: HomeRoutingConfig, locale: Locale): Promise<string | null> {
  return config.newBusinessEventTypeId ? eventTypePath(db, config.newBusinessEventTypeId, locale) : null;
}

/**
 * What the visitor is sent to:
 * - owner: the account manager's default page;
 * - renewal: the renewal page of the book (or the default renewal page);
 * - renewal_rep: a preferred person's default page, when they host the renewal page;
 * - new_business: the new-business page;
 * - none: nothing is bookable, so the home page shows its fallback.
 */
export type DestinationKind = "owner" | "renewal" | "renewal_rep" | "new_business" | "none";

export type Destination = { kind: DestinationKind; path: string | null; repEmail: string | null };

export async function resolveDestination(db: Db, decision: RouteDecision, config: HomeRoutingConfig, locale: Locale): Promise<Destination> {
  if (decision.kind === "owner") {
    const user = await bookableUserByEmail(db, decision.email);
    const path = user ? await personalDefaultPage(db, user.id, locale) : null;
    if (path) return { kind: "owner", path, repEmail: user!.email.toLowerCase() };
  }

  if (decision.kind === "renewal") {
    const candidates = [decision.book ? config.renewalBooks[decision.book] : undefined, config.renewalDefaultEventTypeId].filter(
      (id): id is string => typeof id === "string",
    );
    for (const eventTypeId of candidates) {
      const pagePath = await eventTypePath(db, eventTypeId, locale);
      if (!pagePath) continue;
      for (const email of decision.preferredEmails) {
        const user = await bookableUserByEmail(db, email);
        if (!user || !(await isEligibleHost(db, eventTypeId, user.id))) continue;
        const own = await personalDefaultPage(db, user.id, locale);
        if (own) return { kind: "renewal_rep", path: own, repEmail: user.email.toLowerCase() };
      }
      return { kind: "renewal", path: pagePath, repEmail: null };
    }
  }

  const path = await newBusinessPath(db, config, locale);
  return path ? { kind: "new_business", path, repEmail: null } : { kind: "none", path: null, repEmail: null };
}

/** Only same-site relative paths ("/x", never "//x" or a URL) are returned to the browser. */
export function safeRelativePath(path: string | null): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\s\u0000-\u001f]/.test(path)) return null;
  return path;
}
