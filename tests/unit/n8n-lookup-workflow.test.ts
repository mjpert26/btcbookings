import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lookupResponseSchema } from "@/server/home/decide";

/**
 * Static checks of n8n/account-manager-lookup.json and offline runs of its Code nodes, with
 * stand-ins for the n8n globals ($, $input). Covers the email validation, the SOQL escaping,
 * the response contract the app validates, and that no Salesforce Ids or names leak.
 */

type N8nNode = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown> & { jsCode?: string };
  credentials?: Record<string, { id: string; name: string }>;
  onError?: string;
  webhookId?: string;
};
type Connection = { node: string; type: string; index: number };
type Workflow = {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: Connection[][] }>;
  settings: Record<string, unknown>;
};

const wf = JSON.parse(readFileSync(fileURLToPath(new URL("../../n8n/account-manager-lookup.json", import.meta.url)), "utf8")) as Workflow;
const byName = new Map(wf.nodes.map((n) => [n.name, n]));

function node(name: string): N8nNode {
  const n = byName.get(name);
  if (!n) throw new Error(`Missing node ${name}`);
  return n;
}

function targets(name: string, output: number): string[] {
  return (wf.connections[name]?.main[output] ?? []).map((c) => c.node);
}

/** Stand-in for n8n's $(): data of nodes that ran; unexecuted nodes throw, like n8n. */
function dollar(ran: Record<string, unknown>) {
  return (name: string) => {
    if (!(name in ran)) throw new Error(`Node '${name}' has not been executed`);
    return { first: () => ({ json: ran[name] }) };
  };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

async function runCode(name: string, ran: Record<string, unknown>, input: unknown = {}): Promise<Record<string, unknown>> {
  const code = node(name).parameters.jsCode;
  if (typeof code !== "string") throw new Error(`${name} has no jsCode`);
  const fn = new AsyncFunction("$", "$input", "$env", "require", code);
  const out = (await fn.call({}, dollar(ran), { first: () => ({ json: input }) }, {}, () => {
    throw new Error("require is not available here");
  })) as { json: Record<string, unknown> }[];
  expect(out).toHaveLength(1);
  return out[0].json;
}

/** Renders an n8n "={{ ... }}" parameter with the given node data. */
function render(template: string, ran: Record<string, unknown>): string {
  expect(template.startsWith("=")).toBe(true);
  return template.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr: string) => String(new Function("$", `return (${expr});`)(dollar(ran))));
}

const validate = (body: unknown) => runCode("Validate Email", {}, { headers: {}, body });

describe("n8n/account-manager-lookup.json: structure", () => {
  it("is an importable workflow with the agreed settings", () => {
    expect(wf.name).toBe("BTC Scheduler - Account Manager Lookup");
    expect(wf.settings).toEqual({
      executionOrder: "v1",
      saveDataSuccessExecution: "none",
      saveDataErrorExecution: "none",
      saveManualExecutions: false,
      callerPolicy: "workflowsFromSameOwner",
      errorWorkflow: "Q3Ld5IrQCtGimErY",
      timezone: "America/New_York",
    });

    const names = wf.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    const ids = wf.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of wf.nodes) {
      expect(n.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(n.position.every((v) => Number.isFinite(v))).toBe(true);
    }
    const positions = wf.nodes.map((n) => n.position.join(","));
    expect(new Set(positions).size).toBe(positions.length);

    const VERSIONS: Record<string, number> = {
      "n8n-nodes-base.webhook": 2,
      "n8n-nodes-base.code": 2,
      "n8n-nodes-base.if": 2.2,
      "n8n-nodes-base.executeWorkflow": 1.2,
      "n8n-nodes-base.httpRequest": 4.3,
      "n8n-nodes-base.respondToWebhook": 1.1,
      "n8n-nodes-base.stickyNote": 1,
    };
    for (const n of wf.nodes) expect(VERSIONS[n.type], `${n.name} (${n.type})`).toBe(n.typeVersion);

    // Every connection exists and every node is reachable from the webhook.
    for (const [src, conn] of Object.entries(wf.connections)) {
      expect(byName.has(src), src).toBe(true);
      for (const output of conn.main) for (const c of output) expect(c).toMatchObject({ type: "main", index: 0 });
    }
    const seen = new Set<string>(["Lookup Webhook"]);
    const queue = ["Lookup Webhook"];
    while (queue.length) {
      for (const output of wf.connections[queue.shift()!]?.main ?? []) {
        for (const c of output) {
          expect(byName.has(c.node), c.node).toBe(true);
          if (!seen.has(c.node)) {
            seen.add(c.node);
            queue.push(c.node);
          }
        }
      }
    }
    expect(wf.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote" && !seen.has(n.name)).map((n) => n.name)).toEqual([]);
  });

  it("authenticates the webhook with the Header Auth credential and answers from a Respond node", () => {
    const hook = node("Lookup Webhook");
    expect(hook.parameters).toEqual({ httpMethod: "POST", path: "btc-scheduler/lookup", authentication: "headerAuth", responseMode: "responseNode", options: {} });
    expect(hook.credentials?.httpHeaderAuth.name).toBe("BTC Scheduler lookup token");
    expect(hook.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(node("Respond").parameters).toMatchObject({ respondWith: "json", options: { responseCode: "={{ $json.httpCode }}" } });
  });

  it("wires validation, the token broker, both queries and the response in order", () => {
    expect(targets("Lookup Webhook", 0)).toEqual(["Validate Email"]);
    expect(targets("Validate Email", 0)).toEqual(["Email Valid?"]);
    expect(targets("Email Valid?", 0)).toEqual(["Get SF Token"]);
    expect(targets("Email Valid?", 1)).toEqual(["Respond"]);
    expect(targets("Get SF Token", 0)).toEqual(["Query Opportunities"]);
    expect(targets("Query Opportunities", 0)).toEqual(["Query Leads"]);
    expect(targets("Query Leads", 0)).toEqual(["Shape Response"]);
    expect(targets("Shape Response", 0)).toEqual(["Respond"]);
    expect(node("Get SF Token").parameters).toMatchObject({ workflowId: { __rl: true, value: "7wen5ULQg7DBlCvC", mode: "id" }, mode: "each" });
    for (const q of ["Query Opportunities", "Query Leads"]) {
      const n = node(q);
      expect(n.onError, q).toBe("continueRegularOutput");
      expect(n.parameters.options).toMatchObject({ response: { response: { fullResponse: true, neverError: true } } });
      // The app gives up after 5 seconds; each query must answer well within that.
      expect((n.parameters.options as { timeout: number }).timeout).toBeLessThanOrEqual(4000);
    }
  });
});

describe("n8n/account-manager-lookup.json: Validate Email and the queries", () => {
  it("rejects anything that is not a plausible email with 400", async () => {
    for (const body of [{}, { email: "" }, { email: "not-an-email" }, { email: 5 }, { email: "a b@example.com" }, { email: `${"a".repeat(250)}@x.co` }, { email: "a@b.c\u0000" }]) {
      expect(await validate(body)).toEqual({ ok: false, httpCode: 400, response: { error: "invalid_email" } });
    }
    expect(await validate(undefined)).toMatchObject({ ok: false, httpCode: 400 });
  });

  it("lowercases and escapes the email for SOQL, backslash first", async () => {
    const v = await validate({ email: " O'Brien\\x@Example.com " });
    expect(v).toMatchObject({ ok: true, emailEsc: "o\\'brien\\\\x@example.com" });

    const ran = { "Validate Email": v, "Get SF Token": { access_token: "tok" } };
    const oppUrl = render(node("Query Opportunities").parameters.url as string, ran);
    const [base, q] = oppUrl.split("?q=");
    expect(base).toBe("https://bigthink.my.salesforce.com/services/data/v60.0/query");
    expect(decodeURIComponent(q)).toBe(
      "SELECT StageName, IsClosed, Is_Renewal_Type__c, LastModifiedDate, Owner.Email, Owner.IsActive, Owner.UserType, Renewal_Closer__r.Email, Renewal_Closer__r.IsActive, Account.Renewal_Book__c FROM Opportunity WHERE (csbs__Owner__r.Email = 'o\\'brien\\\\x@example.com' OR csbs__Owner_2__r.Email = 'o\\'brien\\\\x@example.com') AND (IsClosed = false OR StageName IN ('Funded','Renewal Prospecting')) ORDER BY IsClosed ASC, LastModifiedDate DESC LIMIT 50",
    );
    const leadUrl = render(node("Query Leads").parameters.url as string, ran);
    expect(decodeURIComponent(leadUrl.split("?q=")[1])).toBe(
      "SELECT CreatedDate, Owner.Type, Owner.Email, Owner.IsActive FROM Lead WHERE Email = 'o\\'brien\\\\x@example.com' AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 10",
    );
    for (const q of ["Query Opportunities", "Query Leads"]) {
      const headers = (node(q).parameters.headerParameters as { parameters: { name: string; value: string }[] }).parameters;
      expect(render(headers.find((h) => h.name === "Authorization")!.value, ran)).toBe("Bearer tok");
    }
  });
});

describe("n8n/account-manager-lookup.json: Shape Response", () => {
  const ok = (records: unknown[]) => ({ statusCode: 200, body: { totalSize: records.length, done: true, records } });
  const OPP = {
    attributes: { type: "Opportunity", url: "/services/data/v60.0/sobjects/Opportunity/006Hp00000AbCdEIAA" },
    Id: "006Hp00000AbCdEIAA",
    Name: "Ruiz Bakery - Renewal",
    StageName: "Renewal",
    IsClosed: false,
    Is_Renewal_Type__c: false,
    LastModifiedDate: "2026-11-10T15:20:00.000+0000",
    Owner: { attributes: { type: "User" }, Id: "005Hp00000AbCdEIAA", Name: "Ana Rep", Email: "Ana.Rep@BigThinkCapital.com", IsActive: true, UserType: "Standard" },
    Renewal_Closer__r: { attributes: { type: "User" }, Id: "005Hp00000ZzZzZIAA", Email: "CY.closer@bigthinkcapital.com", IsActive: false },
    Account: { attributes: { type: "Account" }, Id: "001Hp00000AbCdEIAA", Name: "Ruiz Bakery LLC", Renewal_Book__c: " Book 2 " },
  };
  const FUNDED = { ...OPP, StageName: "Funded", IsClosed: true, Is_Renewal_Type__c: true, Owner: null, Renewal_Closer__r: null, Account: { Renewal_Book__c: null } };
  const PROSPECTING = { ...OPP, StageName: "Renewal Prospecting", Owner: { Email: "x@bigthinkcapital.com", IsActive: true, UserType: "PowerPartner" } };
  const LEAD = {
    attributes: { type: "Lead" },
    CreatedDate: "2026-10-01T09:00:00.000+0000",
    Owner: { attributes: { type: "Name" }, Id: "00GHp000001AbCd", Type: "Queue", Email: null, IsActive: true },
  };
  const LEAD_USER = { ...LEAD, Owner: { Type: "User", Email: "Bo.Rep@bigthinkcapital.com", IsActive: true, Name: "Bo Rep" } };

  it("maps the queries to the app's contract and leaks no Ids, names or stages", async () => {
    const out = await runCode("Shape Response", { "Query Opportunities": ok([OPP, FUNDED, PROSPECTING]), "Query Leads": ok([LEAD, LEAD_USER]) });
    expect(out.httpCode).toBe(200);
    expect(out.response).toEqual({
      opportunities: [
        {
          open: true,
          renewal: true,
          funded: false,
          lastModified: "2026-11-10T15:20:00.000Z",
          owner: { email: "ana.rep@bigthinkcapital.com", active: true, standard: true },
          renewalCloser: { email: "cy.closer@bigthinkcapital.com", active: false },
          book: "Book 2",
        },
        { open: false, renewal: true, funded: true, lastModified: "2026-11-10T15:20:00.000Z", owner: null, renewalCloser: null, book: null },
        {
          open: true,
          renewal: false,
          funded: true,
          lastModified: "2026-11-10T15:20:00.000Z",
          owner: { email: "x@bigthinkcapital.com", active: true, standard: false },
          renewalCloser: { email: "cy.closer@bigthinkcapital.com", active: false },
          book: "Book 2",
        },
      ],
      leads: [
        { createdAt: "2026-10-01T09:00:00.000Z", owner: null },
        { createdAt: "2026-10-01T09:00:00.000Z", owner: { email: "bo.rep@bigthinkcapital.com", active: true, isUser: true } },
      ],
    });
    // The app accepts exactly this shape.
    expect(lookupResponseSchema.safeParse(out.response).success).toBe(true);
    const text = JSON.stringify(out);
    for (const leaked of ["006Hp", "005Hp", "001Hp", "00GHp", "Ruiz", "Ana Rep", "Bo Rep", "Renewal Prospecting", "attributes", '"Funded"']) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("caps the arrays and answers an empty match", async () => {
    const many = await runCode("Shape Response", {
      "Query Opportunities": ok(Array.from({ length: 60 }, () => OPP)),
      "Query Leads": ok(Array.from({ length: 12 }, () => LEAD)),
    });
    const response = many.response as { opportunities: unknown[]; leads: unknown[] };
    expect(response.opportunities).toHaveLength(50);
    expect(response.leads).toHaveLength(10);
    expect(await runCode("Shape Response", { "Query Opportunities": ok([]), "Query Leads": ok([]) })).toEqual({
      httpCode: 200,
      response: { opportunities: [], leads: [] },
    });
  });

  it("answers 502 lookup_failed when a query failed", async () => {
    const failed = { httpCode: 502, response: { error: "lookup_failed" } };
    expect(await runCode("Shape Response", { "Query Opportunities": { statusCode: 401, body: [{ errorCode: "INVALID_SESSION_ID" }] }, "Query Leads": ok([]) })).toEqual(failed);
    expect(await runCode("Shape Response", { "Query Opportunities": ok([]), "Query Leads": { error: { message: "ETIMEDOUT" } } })).toEqual(failed);
    expect(await runCode("Shape Response", { "Query Opportunities": ok([]) })).toEqual(failed);
    expect(await runCode("Shape Response", { "Query Opportunities": { statusCode: 200, body: { records: "x" } }, "Query Leads": ok([]) })).toEqual(failed);
  });
});
