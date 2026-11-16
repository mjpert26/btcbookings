import { DateTime } from "luxon";
import { z } from "zod";

/**
 * Home page routing: the response of the n8n account-manager lookup and the pure decision
 * that turns it into a route. No I/O here; the destination (a booking page path) is resolved
 * against the database in src/server/home/destination.ts.
 *
 * Precedence (docs/home-page.md):
 *   1. An open, non-renewal, not funded Opportunity whose owner is a real owner: that owner
 *      (newest by lastModified).
 *   2. A renewal signal (an open Opportunity with renewal=true, or any funded Opportunity):
 *      route "renewal" with the book of an open renewal Opportunity (newest), else of the most
 *      recently modified funded one. The owner and the renewal closer of an open renewal
 *      Opportunity, when real, are carried as preferred people.
 *   3. An open Lead whose owner is a real user owner: that owner (newest by createdAt).
 *   4. Otherwise "new".
 */

export const MAX_OPPORTUNITIES = 50;
export const MAX_LEADS = 10;

const email = z.string().trim().toLowerCase().max(254);
const text = z.string().max(64);

const opportunitySchema = z.object({
  open: z.boolean(),
  renewal: z.boolean(),
  funded: z.boolean(),
  lastModified: text,
  owner: z.object({ email, active: z.boolean(), standard: z.boolean() }).nullable(),
  renewalCloser: z.object({ email, active: z.boolean() }).nullable(),
  book: z.string().trim().max(100).nullable(),
});

const leadSchema = z.object({
  createdAt: text,
  owner: z.object({ email, active: z.boolean(), isUser: z.boolean() }).nullable(),
});

/** The body n8n returns. Unknown fields are dropped; arrays are capped. */
export const lookupResponseSchema = z.object({
  opportunities: z.array(opportunitySchema).max(MAX_OPPORTUNITIES),
  leads: z.array(leadSchema).max(MAX_LEADS),
});

export type LookupData = z.infer<typeof lookupResponseSchema>;
export type LookupOpportunity = LookupData["opportunities"][number];
export type LookupLead = LookupData["leads"][number];

export type RouteDecision =
  | { kind: "owner"; email: string; source: "opportunity" | "lead" }
  /** preferredEmails: real owner first, then real renewal closer, of an open renewal Opportunity. */
  | { kind: "renewal"; book: string | null; preferredEmails: string[] }
  | { kind: "new" };

export type DecisionRules = {
  /** Lowercase email domains a real owner may have (ALLOWED_EMAIL_DOMAINS). */
  allowedDomains: readonly string[];
  /** Owner emails that never count as a real owner (Admin > Home page). Compared case-insensitively. */
  excludedEmails: readonly string[];
};

const NO_MATCH: RouteDecision = { kind: "new" };

/** Milliseconds since the epoch, or -Infinity when the timestamp cannot be parsed (sorts last). */
export function timestamp(value: string): number {
  const dt = DateTime.fromISO(value, { setZone: true });
  return dt.isValid ? dt.toMillis() : Number.NEGATIVE_INFINITY;
}

/** Newest first; equal timestamps keep their input order (n8n already sorts by date). */
function newestFirst<T>(items: readonly T[], at: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, ts: timestamp(at(item)) }))
    .sort((a, b) => (b.ts === a.ts ? a.index - b.index : b.ts > a.ts ? 1 : -1))
    .map((x) => x.item);
}

function domainAllowed(address: string, rules: DecisionRules): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return rules.allowedDomains.some((d) => d.toLowerCase() === domain);
}

function excluded(address: string, rules: DecisionRules): boolean {
  const lower = address.toLowerCase();
  return rules.excludedEmails.some((e) => e.trim().toLowerCase() === lower);
}

/** A real person with an allowed domain who is not on the excluded list. */
function realPerson(address: string, active: boolean, rules: DecisionRules): boolean {
  return active && domainAllowed(address, rules) && !excluded(address, rules);
}

/** Opportunity owner: active standard Salesforce user, allowed domain, not excluded. */
export function isRealOpportunityOwner(owner: LookupOpportunity["owner"], rules: DecisionRules): owner is NonNullable<LookupOpportunity["owner"]> {
  return !!owner && owner.standard && realPerson(owner.email, owner.active, rules);
}

/** Renewal closer: active, allowed domain, not excluded. */
export function isRealRenewalCloser(closer: LookupOpportunity["renewalCloser"], rules: DecisionRules): closer is NonNullable<LookupOpportunity["renewalCloser"]> {
  return !!closer && realPerson(closer.email, closer.active, rules);
}

/** Lead owner: an active user (not a queue), allowed domain, not excluded. */
export function isRealLeadOwner(owner: LookupLead["owner"], rules: DecisionRules): owner is NonNullable<LookupLead["owner"]> {
  return !!owner && owner.isUser && realPerson(owner.email, owner.active, rules);
}

/** Applies the routing precedence to one lookup result. Never throws. */
export function decideRoute(data: LookupData | null, rules: DecisionRules): RouteDecision {
  if (!data) return NO_MATCH;
  const opportunities = newestFirst(data.opportunities, (o) => o.lastModified);

  // 1. Open non-renewal Opportunity with a real owner. A funded Opportunity is a renewal
  //    signal even while it is open (for example the stage Renewal Prospecting).
  for (const o of opportunities) {
    if (o.open && !o.renewal && !o.funded && isRealOpportunityOwner(o.owner, rules)) {
      return { kind: "owner", email: o.owner.email.toLowerCase(), source: "opportunity" };
    }
  }

  // 2. Renewal: prefer an open renewal Opportunity, else the most recently modified funded one.
  const openRenewal = opportunities.find((o) => o.open && o.renewal);
  const funded = opportunities.find((o) => o.funded);
  const signal = openRenewal ?? funded;
  if (signal) {
    const preferredEmails: string[] = [];
    if (openRenewal) {
      if (isRealOpportunityOwner(openRenewal.owner, rules)) preferredEmails.push(openRenewal.owner.email.toLowerCase());
      if (isRealRenewalCloser(openRenewal.renewalCloser, rules)) preferredEmails.push(openRenewal.renewalCloser.email.toLowerCase());
    }
    const book = signal.book && signal.book.trim() ? signal.book.trim() : null;
    return { kind: "renewal", book, preferredEmails: [...new Set(preferredEmails)] };
  }

  // 3. Open Lead with a real user owner.
  for (const lead of newestFirst(data.leads, (l) => l.createdAt)) {
    if (isRealLeadOwner(lead.owner, rules)) return { kind: "owner", email: lead.owner.email.toLowerCase(), source: "lead" };
  }

  // 4. New applicant.
  return NO_MATCH;
}
