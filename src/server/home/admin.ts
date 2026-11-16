import "server-only";
import { z } from "zod";
import { service, withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { DEFAULT_EXCLUDED_OWNER_EMAILS, MAX_EXCLUDED_OWNER_EMAILS, RENEWAL_BOOKS } from "@/lib/home-routing";
import { parseRenewalBooks } from "@/server/home/destination";
import { routeVisitor } from "@/server/home/route";
import type { DestinationKind } from "@/server/home/destination";
import type { LookupOutcome } from "@/server/home/lookup";

/**
 * Admin > Home page: which booking pages the public home page sends visitors to, and which
 * Salesforce owners never count as an account manager. Every function runs as the signed-in
 * user under row-level security, checks app.is_admin(), and writes the audit entry in the same
 * transaction as the change (entity type "home_routing").
 */

export class HomeRoutingError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid",
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "HomeRoutingError";
  }
}

async function assertAdmin(tx: Tx): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!row?.ok) throw new HomeRoutingError("forbidden", "Admin access required.");
}

export type HomeRoutingState = {
  newBusinessEventTypeId: string | null;
  renewalDefaultEventTypeId: string | null;
  renewalBooks: Record<string, string>;
  excludedOwnerEmails: string[];
  updatedAt: Date | null;
  updatedByName: string | null;
};

/** One booking page an admin can choose. Variants (other languages) follow their parent. */
export type PageOption = {
  id: string;
  name: string;
  slug: string;
  ownerName: string;
  isTeam: boolean;
  schedulingMode: string;
  isActive: boolean;
  /** Active variant languages, including the page's own language. */
  languages: string[];
};

export type HomeRoutingEdit = {
  state: HomeRoutingState;
  /** Team round-robin and collective pages, for the new-business page. */
  newBusinessOptions: PageOption[];
  /** Every team and personal page, for the renewal pages. */
  renewalOptions: PageOption[];
};

type StateRow = {
  new_business_event_type_id: string | null;
  renewal_default_event_type_id: string | null;
  renewal_books: unknown;
  excluded_owner_emails: string[];
  updated_at: Date;
  updated_by_name: string | null;
};

async function readState(tx: Tx): Promise<HomeRoutingState | null> {
  const [row] = await tx<StateRow[]>`
    select h.new_business_event_type_id, h.renewal_default_event_type_id, h.renewal_books,
           h.excluded_owner_emails::text[] as excluded_owner_emails, h.updated_at, u.name as updated_by_name
    from app.home_routing h left join app.users u on u.id = h.updated_by
    where h.id
  `;
  if (!row) return null;
  return {
    newBusinessEventTypeId: row.new_business_event_type_id,
    renewalDefaultEventTypeId: row.renewal_default_event_type_id,
    renewalBooks: parseRenewalBooks(row.renewal_books),
    excludedOwnerEmails: row.excluded_owner_emails.map((e) => e.toLowerCase()),
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

type OptionRow = {
  id: string;
  name: string;
  slug: string;
  owner_name: string | null;
  team_name: string | null;
  team_id: string | null;
  scheduling_mode: string;
  is_active: boolean;
  languages: string[] | null;
};

async function pageOptions(tx: Tx): Promise<PageOption[]> {
  const rows = await tx<OptionRow[]>`
    select et.id, et.name, et.slug, u.name as owner_name, t.name as team_name, et.team_id,
           et.scheduling_mode::text as scheduling_mode, et.is_active,
           array(
             select v.language from app.event_types v
             where (v.id = et.id or v.parent_event_type_id = et.id) and v.is_active
             order by v.language
           ) as languages
    from app.event_types et
    left join app.users u on u.id = et.owner_user_id
    left join app.teams t on t.id = et.team_id
    where et.parent_event_type_id is null
    order by (et.team_id is null), coalesce(t.name, u.name), et.name
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    ownerName: r.team_name ?? r.owner_name ?? "",
    isTeam: r.team_id !== null,
    schedulingMode: r.scheduling_mode,
    isActive: r.is_active,
    languages: r.languages ?? [],
  }));
}

const isTeamPool = (o: PageOption) => o.isTeam && (o.schedulingMode === "round_robin" || o.schedulingMode === "collective");

export async function getHomeRoutingForEdit(user: SessionUser): Promise<HomeRoutingEdit> {
  return withUser(user.id, async (tx) => {
    await assertAdmin(tx);
    const [state, options] = await Promise.all([readState(tx), pageOptions(tx)]);
    return {
      state: state ?? {
        newBusinessEventTypeId: null,
        renewalDefaultEventTypeId: null,
        renewalBooks: {},
        excludedOwnerEmails: [...DEFAULT_EXCLUDED_OWNER_EMAILS],
        updatedAt: null,
        updatedByName: null,
      },
      newBusinessOptions: options.filter(isTeamPool),
      renewalOptions: options,
    };
  });
}

const emailSchema = z.string().max(254).pipe(z.email());

/**
 * Parses the excluded owner emails typed one per line (commas and semicolons also separate).
 * Lowercased, deduplicated, at most MAX_EXCLUDED_OWNER_EMAILS.
 */
export function parseExcludedEmails(text: string): { ok: true; emails: string[] } | { ok: false; error: string } {
  const items = text
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = items.filter((e) => !emailSchema.safeParse(e).success);
  if (invalid.length) {
    const shown = invalid.slice(0, 3).join(", ");
    return { ok: false, error: `Not a valid email address: ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}.` };
  }
  const emails = [...new Set(items)];
  if (emails.length > MAX_EXCLUDED_OWNER_EMAILS) return { ok: false, error: `Enter at most ${MAX_EXCLUDED_OWNER_EMAILS} email addresses.` };
  return { ok: true, emails };
}

const optionalId = z.union([z.literal(""), z.uuid("Choose a booking page from the list.")]).transform((v) => (v === "" ? null : v));

export const homeRoutingInputSchema = z.object({
  newBusinessEventTypeId: optionalId,
  renewalDefaultEventTypeId: optionalId,
  renewalBooks: z.object(Object.fromEntries(RENEWAL_BOOKS.map((b) => [b, optionalId])) as Record<(typeof RENEWAL_BOOKS)[number], typeof optionalId>),
  excludedOwnerEmails: z.string().max(30_000, "The list is too long."),
});

export type HomeRoutingInput = z.input<typeof homeRoutingInputSchema>;

/** Field name used in the form for each renewal book. */
export function bookField(book: string): string {
  return `book:${book}`;
}

/** Saves the configuration. Throws HomeRoutingError for a non-admin or invalid input. */
export async function saveHomeRouting(user: SessionUser, input: HomeRoutingInput): Promise<HomeRoutingState> {
  const parsed = homeRoutingInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const [head, sub] = issue.path.map(String);
      const key = head === "renewalBooks" && sub ? bookField(sub) : head;
      fieldErrors[key] ??= issue.message;
    }
    throw new HomeRoutingError("invalid", "Please fix the highlighted fields.", fieldErrors);
  }
  const v = parsed.data;
  const emails = parseExcludedEmails(v.excludedOwnerEmails);
  if (!emails.ok) throw new HomeRoutingError("invalid", emails.error, { excludedOwnerEmails: emails.error });
  const renewalBooks = Object.fromEntries(Object.entries(v.renewalBooks).filter((e): e is [string, string] => e[1] !== null));

  return withUser(user.id, async (tx) => {
    await assertAdmin(tx);

    // Every chosen page must be a top-level event type; the new-business page a team pool.
    const ids = [...new Set([v.newBusinessEventTypeId, v.renewalDefaultEventTypeId, ...Object.values(renewalBooks)].filter((x): x is string => !!x))];
    const found = ids.length
      ? await tx<{ id: string; team_id: string | null; scheduling_mode: string }[]>`
          select id, team_id, scheduling_mode::text as scheduling_mode from app.event_types
          where id = any(${ids}::uuid[]) and parent_event_type_id is null
        `
      : [];
    const byId = new Map(found.map((r) => [r.id, r]));
    const fieldErrors: Record<string, string> = {};
    const check = (field: string, id: string | null) => {
      if (id && !byId.has(id)) fieldErrors[field] = "This booking page no longer exists. Choose another one.";
    };
    check("newBusinessEventTypeId", v.newBusinessEventTypeId);
    check("renewalDefaultEventTypeId", v.renewalDefaultEventTypeId);
    for (const [book, id] of Object.entries(renewalBooks)) check(bookField(book), id);
    const nb = v.newBusinessEventTypeId ? byId.get(v.newBusinessEventTypeId) : undefined;
    if (nb && (!nb.team_id || !["round_robin", "collective"].includes(nb.scheduling_mode))) {
      fieldErrors.newBusinessEventTypeId = "Choose a team round-robin or collective booking page.";
    }
    if (Object.keys(fieldErrors).length) throw new HomeRoutingError("invalid", "Please fix the highlighted fields.", fieldErrors);

    const before = await readState(tx);
    await tx`
      insert into app.home_routing (id, new_business_event_type_id, renewal_default_event_type_id, renewal_books, excluded_owner_emails, updated_by)
      values (true, ${v.newBusinessEventTypeId}, ${v.renewalDefaultEventTypeId}, ${tx.json(renewalBooks)},
              ${emails.emails}::citext[], ${user.id})
      on conflict (id) do update set
        new_business_event_type_id = excluded.new_business_event_type_id,
        renewal_default_event_type_id = excluded.renewal_default_event_type_id,
        renewal_books = excluded.renewal_books,
        excluded_owner_emails = excluded.excluded_owner_emails,
        updated_by = excluded.updated_by
    `;
    const after = (await readState(tx))!;
    const view = (s: HomeRoutingState | null) =>
      s && {
        newBusinessEventTypeId: s.newBusinessEventTypeId,
        renewalDefaultEventTypeId: s.renewalDefaultEventTypeId,
        renewalBooks: s.renewalBooks,
        excludedOwnerEmails: s.excludedOwnerEmails,
      };
    await writeAudit(tx, { actorUserId: user.id, action: "home_routing.update", entityType: "home_routing", before: view(before), after: view(after) });
    return after;
  });
}

export type HomeRoutingTestResult = {
  /** The Salesforce decision: owner, renewal or new. */
  decision: "owner" | "renewal" | "new";
  /** Where the visitor would go. */
  destination: DestinationKind;
  /** The employee the visitor would book with, when the destination is a person's page. */
  repEmail: string | null;
  /** The account manager or renewal book Salesforce pointed to (employees only). */
  matchedEmail: string | null;
  book: string | null;
  path: string | null;
  /** "ok", or why the lookup did not run or failed (treated as no match). */
  lookup: string;
};

/**
 * Runs the same lookup and decision as the public home page for one email, for Admin > Home
 * page. Writes nothing but one audit entry, which records the outcome and not the email.
 */
export async function testHomeRouting(
  user: SessionUser,
  email: string,
  opts: { lookup?: (email: string) => Promise<LookupOutcome> } = {},
): Promise<HomeRoutingTestResult> {
  await withUser(user.id, assertAdmin);
  const parsed = z.string().trim().max(254).pipe(z.email()).safeParse(email);
  if (!parsed.success) throw new HomeRoutingError("invalid", "Enter a valid email address.", { email: "Enter a valid email address." });
  const result = await routeVisitor(parsed.data.toLowerCase(), { locale: "en", db: service(), lookup: opts.lookup });
  const d = result.decision;
  const out: HomeRoutingTestResult = {
    decision: d.kind,
    destination: result.destination.kind,
    repEmail: result.destination.repEmail,
    matchedEmail: d.kind === "owner" ? d.email : d.kind === "renewal" ? (d.preferredEmails[0] ?? null) : null,
    book: d.kind === "renewal" ? d.book : null,
    path: result.next,
    lookup: result.lookup,
  };
  await withUser(user.id, (tx) =>
    writeAudit(tx, {
      actorUserId: user.id,
      action: "home_routing.test",
      entityType: "home_routing",
      after: { decision: out.decision, destination: out.destination, lookup: out.lookup },
    }),
  );
  return out;
}
