import { describe, expect, it } from "vitest";
import {
  decideRoute,
  isRealLeadOwner,
  isRealOpportunityOwner,
  lookupResponseSchema,
  timestamp,
  type DecisionRules,
  type LookupData,
  type LookupLead,
  type LookupOpportunity,
} from "@/server/home/decide";
import { DEFAULT_EXCLUDED_OWNER_EMAILS } from "@/lib/home-routing";

/** Routing precedence for the home page lookup (docs/home-page.md) and the n8n response contract. */

const RULES: DecisionRules = { allowedDomains: ["bigthinkcapital.com"], excludedEmails: [...DEFAULT_EXCLUDED_OWNER_EMAILS] };

const REP = "ana.rep@bigthinkcapital.com";
const REP2 = "bo.rep@bigthinkcapital.com";
const CLOSER = "cy.closer@bigthinkcapital.com";

function opp(over: Partial<LookupOpportunity> = {}): LookupOpportunity {
  return {
    open: true,
    renewal: false,
    funded: false,
    lastModified: "2026-11-01T12:00:00.000Z",
    owner: { email: REP, active: true, standard: true },
    renewalCloser: null,
    book: null,
    ...over,
  };
}

function lead(over: Partial<LookupLead> = {}): LookupLead {
  return { createdAt: "2026-10-01T12:00:00.000Z", owner: { email: REP, active: true, isUser: true }, ...over };
}

const data = (opportunities: LookupOpportunity[] = [], leads: LookupLead[] = []): LookupData => ({ opportunities, leads });

describe("decideRoute: rule 1, open non-renewal Opportunity", () => {
  it("routes to the owner of the newest open non-renewal Opportunity", () => {
    const d = decideRoute(
      data([
        opp({ owner: { email: REP2, active: true, standard: true }, lastModified: "2026-10-01T00:00:00Z" }),
        opp({ owner: { email: "Ana.Rep@BigThinkCapital.com", active: true, standard: true }, lastModified: "2026-11-02T00:00:00Z" }),
      ]),
      RULES,
    );
    expect(d).toEqual({ kind: "owner", email: REP, source: "opportunity" });
  });

  it("keeps the input order on equal dates", () => {
    const at = "2026-11-02T00:00:00Z";
    const d = decideRoute(data([opp({ owner: { email: REP2, active: true, standard: true }, lastModified: at }), opp({ lastModified: at })]), RULES);
    expect(d).toMatchObject({ kind: "owner", email: REP2 });
    // Salesforce offsets without a colon parse too, and unparseable dates sort last.
    expect(timestamp("2026-11-10T15:20:00.000+0000")).toBe(Date.UTC(2026, 10, 10, 15, 20));
    const d2 = decideRoute(data([opp({ owner: { email: REP2, active: true, standard: true }, lastModified: "garbage" }), opp({ lastModified: "2020-01-01T00:00:00Z" })]), RULES);
    expect(d2).toMatchObject({ kind: "owner", email: REP });
  });

  it("skips owners that are not real and falls through to the next Opportunity", () => {
    const skipped: LookupOpportunity["owner"][] = [
      { email: "teamdc@bigthinkcapital.com", active: true, standard: true }, // excluded
      { email: "TEAMAXKAP@bigthinkcapital.com", active: true, standard: true }, // excluded, any case
      { email: "rep@othercompany.com", active: true, standard: true }, // domain
      { email: "old.rep@bigthinkcapital.com", active: false, standard: true }, // inactive
      { email: "partner@bigthinkcapital.com", active: true, standard: false }, // not a standard user
      null,
    ];
    for (const owner of skipped) {
      expect(isRealOpportunityOwner(owner, RULES)).toBe(false);
      expect(decideRoute(data([opp({ owner, lastModified: "2026-12-01T00:00:00Z" }), opp({ lastModified: "2026-01-01T00:00:00Z" })]), RULES)).toEqual({
        kind: "owner",
        email: REP,
        source: "opportunity",
      });
    }
    expect(isRealOpportunityOwner({ email: REP, active: true, standard: true }, RULES)).toBe(true);
  });

  it("ignores closed, renewal and funded Opportunities for rule 1", () => {
    expect(decideRoute(data([opp({ open: false })]), RULES)).toEqual({ kind: "new" });
    expect(decideRoute(data([opp({ renewal: true })]), RULES)).toMatchObject({ kind: "renewal" });
    expect(decideRoute(data([opp({ funded: true })]), RULES)).toMatchObject({ kind: "renewal" });
  });

  it("uses the allowed domains and excluded list it is given", () => {
    const rules: DecisionRules = { allowedDomains: ["example.com"], excludedEmails: [] };
    expect(decideRoute(data([opp({ owner: { email: "teamdc@example.com", active: true, standard: true } })]), rules)).toMatchObject({
      kind: "owner",
      email: "teamdc@example.com",
    });
    expect(decideRoute(data([opp()]), rules)).toEqual({ kind: "new" });
    expect(isRealOpportunityOwner({ email: "@bigthinkcapital.com", active: true, standard: true }, RULES)).toBe(false);
    expect(isRealOpportunityOwner({ email: "x@sub.bigthinkcapital.com", active: true, standard: true }, RULES)).toBe(false);
  });

  it("wins over renewal signals and Leads", () => {
    const d = decideRoute(
      data([opp({ funded: true, open: false, book: "Book 1" }), opp({ renewal: true, book: "Book 2" }), opp({ owner: { email: REP2, active: true, standard: true } })], [lead()]),
      RULES,
    );
    expect(d).toEqual({ kind: "owner", email: REP2, source: "opportunity" });
  });
});

describe("decideRoute: rule 2, renewal", () => {
  it("prefers an open renewal Opportunity and carries its real owner, then its real closer", () => {
    const d = decideRoute(
      data([
        opp({ funded: true, open: false, book: "Book 1", lastModified: "2026-11-05T00:00:00Z" }),
        opp({ renewal: true, book: " Book 2 ", lastModified: "2026-10-01T00:00:00Z", renewalCloser: { email: CLOSER, active: true } }),
      ]),
      RULES,
    );
    expect(d).toEqual({ kind: "renewal", book: "Book 2", preferredEmails: [REP, CLOSER] });
  });

  it("uses the newest open renewal Opportunity", () => {
    const d = decideRoute(
      data([
        opp({ renewal: true, book: "Book 1", lastModified: "2026-09-01T00:00:00Z" }),
        opp({ renewal: true, book: "House Book", lastModified: "2026-10-01T00:00:00Z", owner: null }),
      ]),
      RULES,
    );
    expect(d).toEqual({ kind: "renewal", book: "House Book", preferredEmails: [] });
  });

  it("carries only real people as preferred", () => {
    const d = decideRoute(
      data([
        opp({
          renewal: true,
          book: "Book 3",
          owner: { email: "sdr.roundrobin@bigthinkcapital.com", active: true, standard: true },
          renewalCloser: { email: CLOSER, active: true },
        }),
      ]),
      RULES,
    );
    expect(d).toEqual({ kind: "renewal", book: "Book 3", preferredEmails: [CLOSER] });
    const none = decideRoute(data([opp({ renewal: true, owner: { email: REP, active: false, standard: true }, renewalCloser: { email: "x@gmail.com", active: true } })]), RULES);
    expect(none).toEqual({ kind: "renewal", book: null, preferredEmails: [] });
    const same = decideRoute(data([opp({ renewal: true, renewalCloser: { email: REP, active: true } })]), RULES);
    expect(same).toEqual({ kind: "renewal", book: null, preferredEmails: [REP] });
  });

  it("falls back to the most recently modified funded Opportunity, without preferred people", () => {
    const d = decideRoute(
      data([
        opp({ funded: true, open: false, book: "Book 1", lastModified: "2026-01-01T00:00:00Z" }),
        opp({ funded: true, open: false, book: "Book 2", lastModified: "2026-06-01T00:00:00Z", renewalCloser: { email: CLOSER, active: true } }),
        opp({ open: false, renewal: true, book: "Book 3" }),
      ]),
      RULES,
    );
    expect(d).toEqual({ kind: "renewal", book: "Book 2", preferredEmails: [] });
  });

  it("routes an open funded Opportunity (Renewal Prospecting) as a renewal, not to its owner", () => {
    expect(decideRoute(data([opp({ funded: true, book: "Book 1" })]), RULES)).toEqual({ kind: "renewal", book: "Book 1", preferredEmails: [] });
  });

  it("wins over Leads", () => {
    expect(decideRoute(data([opp({ funded: true, open: false })], [lead()]), RULES)).toMatchObject({ kind: "renewal" });
  });
});

describe("decideRoute: rule 3 and 4, Leads and new", () => {
  it("routes to the owner of the newest Lead with a real user owner", () => {
    const d = decideRoute(
      data([], [lead({ createdAt: "2026-01-01T00:00:00Z" }), lead({ createdAt: "2026-03-01T00:00:00Z", owner: { email: REP2, active: true, isUser: true } })]),
      RULES,
    );
    expect(d).toEqual({ kind: "owner", email: REP2, source: "lead" });
  });

  it("skips queue owners, inactive, excluded and outside owners", () => {
    const skipped: LookupLead["owner"][] = [
      { email: "queue@bigthinkcapital.com", active: true, isUser: false },
      { email: REP2, active: false, isUser: true },
      { email: "shaine@forml.ai", active: true, isUser: true },
      { email: "jessica.marks2@bigthinkcapital.com", active: true, isUser: true },
      { email: "rep@gmail.com", active: true, isUser: true },
      null,
    ];
    for (const owner of skipped) {
      expect(isRealLeadOwner(owner, RULES)).toBe(false);
      expect(decideRoute(data([], [lead({ owner, createdAt: "2026-12-01T00:00:00Z" })]), RULES)).toEqual({ kind: "new" });
    }
    expect(decideRoute(data([], [lead({ owner: skipped[0], createdAt: "2026-12-01T00:00:00Z" }), lead()]), RULES)).toMatchObject({ kind: "owner", email: REP });
  });

  it("is new without data, without matches, or when nothing qualifies", () => {
    expect(decideRoute(null, RULES)).toEqual({ kind: "new" });
    expect(decideRoute(data(), RULES)).toEqual({ kind: "new" });
    expect(decideRoute(data([opp({ open: false })], [lead({ owner: null })]), RULES)).toEqual({ kind: "new" });
  });
});

describe("lookupResponseSchema", () => {
  const valid = {
    opportunities: [
      { ...opp({ renewal: true, book: "Book 1", renewalCloser: { email: " Cy.Closer@BigThinkCapital.com ", active: true } }), extra: "dropped", Id: "006xx" },
    ],
    leads: [lead({ owner: null })],
  };

  it("accepts the contract, lowercases emails and drops unknown fields", () => {
    const parsed = lookupResponseSchema.parse(valid);
    expect(parsed.opportunities[0]).not.toHaveProperty("Id");
    expect(parsed.opportunities[0]).not.toHaveProperty("extra");
    expect(parsed.opportunities[0].renewalCloser).toEqual({ email: CLOSER, active: true });
    expect(parsed.leads[0].owner).toBeNull();
    expect(lookupResponseSchema.parse({ opportunities: [], leads: [] })).toEqual({ opportunities: [], leads: [] });
  });

  it("rejects missing fields, wrong types and oversized arrays", () => {
    expect(lookupResponseSchema.safeParse({ opportunities: [] }).success).toBe(false);
    expect(lookupResponseSchema.safeParse({ opportunities: [{ ...opp(), open: "true" }], leads: [] }).success).toBe(false);
    expect(lookupResponseSchema.safeParse({ opportunities: [{ ...opp(), owner: { email: REP, active: true } }], leads: [] }).success).toBe(false);
    expect(lookupResponseSchema.safeParse({ opportunities: [], leads: [{ createdAt: "x", owner: { email: REP, active: true } }] }).success).toBe(false);
    expect(lookupResponseSchema.safeParse({ opportunities: Array.from({ length: 51 }, () => opp()), leads: [] }).success).toBe(false);
    expect(lookupResponseSchema.safeParse({ opportunities: [], leads: Array.from({ length: 11 }, () => lead()) }).success).toBe(false);
    expect(lookupResponseSchema.safeParse({ opportunities: [{ ...opp(), owner: { email: "a".repeat(300), active: true, standard: true } }], leads: [] }).success).toBe(false);
    expect(lookupResponseSchema.safeParse(null).success).toBe(false);
    expect(lookupResponseSchema.safeParse("ok").success).toBe(false);
  });
});
