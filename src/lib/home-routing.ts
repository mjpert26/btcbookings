/**
 * Shared constants for the public home page routing (Admin > Home page).
 */

/** Salesforce renewal books (Account.Renewal_Book__c) that get their own row in Admin > Home page. */
export const RENEWAL_BOOKS = ["Book 1", "Book 2", "Book 3", "House Book"] as const;

/** Most excluded owner emails Admin > Home page accepts. */
export const MAX_EXCLUDED_OWNER_EMAILS = 100;

/**
 * Salesforce owners that are never a visitor's account manager: shared, queue-like and
 * integration users. The migration seeds app.home_routing with the same list; it also applies
 * when the row is missing.
 */
export const DEFAULT_EXCLUDED_OWNER_EMAILS = [
  "jessica.marks@bigthinkcapital.com",
  "jessica.marks2@bigthinkcapital.com",
  "jessica.marks3@bigthinkcapital.com",
  "jessica.marks4@bigthinkcapital.com",
  "teamaxkap@bigthinkcapital.com",
  "teamdc@bigthinkcapital.com",
  "sdr.roundrobin@bigthinkcapital.com",
  "shaine@forml.ai",
] as const;

/** Personal booking page slugs tried, in order, when sending a visitor to their own rep. */
export const DEFAULT_PAGE_SLUGS = ["15min", "30min", "financing-intro-call"] as const;
