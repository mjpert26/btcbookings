import "server-only";
import { service, type Db } from "@/server/db/client";
import { allowedEmailDomains } from "@/server/env";
import type { Locale } from "@/i18n/locales";
import { decideRoute, type RouteDecision } from "@/server/home/decide";
import { lookupAccount, type LookupOutcome } from "@/server/home/lookup";
import { readHomeRouting, resolveDestination, safeRelativePath, type Destination } from "@/server/home/destination";

/**
 * The whole home page lookup: Salesforce data through n8n, the routing decision and the
 * booking page. Shared by the public route (/api/public/lookup), which returns only `next`,
 * and the admin test form, which shows the decision as well.
 */

export type HomeRouteResult = {
  /** Relative path of the booking page, or null when nothing is bookable. */
  next: string | null;
  decision: RouteDecision;
  destination: Destination;
  /** "ok", "skipped" (daily cap), or the short reason the lookup failed. */
  lookup: string;
};

export type RouteOptions = {
  locale: Locale;
  db?: Db;
  /** Skips the n8n call and routes to the new-business page (daily cap reached). */
  skipLookup?: boolean;
  lookup?: (email: string) => Promise<LookupOutcome>;
};

export async function routeVisitor(email: string, opts: RouteOptions): Promise<HomeRouteResult> {
  const db = opts.db ?? service();
  const config = await readHomeRouting(db);

  let lookup = "skipped";
  let decision: RouteDecision = { kind: "new" };
  if (!opts.skipLookup) {
    const outcome = await (opts.lookup ?? lookupAccount)(email);
    if (outcome.ok) {
      lookup = "ok";
      decision = decideRoute(outcome.data, { allowedDomains: allowedEmailDomains(), excludedEmails: config.excludedOwnerEmails });
    } else {
      lookup = outcome.reason;
      // A short reason only: never the email, the token or the response body.
      if (outcome.reason !== "no_token") console.warn(JSON.stringify({ msg: "home lookup failed; routing as new", reason: outcome.reason }));
    }
  }

  const destination = await resolveDestination(db, decision, config, opts.locale);
  return { next: safeRelativePath(destination.path), decision, destination, lookup };
}
