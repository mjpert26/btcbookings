import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Static checks of n8n/sf-lead-create.json and offline runs of its Code nodes. The Code
 * nodes are executed with stand-ins for the n8n globals ($, $input, $env), so the decision
 * rules, the SOQL escaping and the response contract are tested without an n8n instance.
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
  alwaysOutputData?: boolean;
};
type Connection = { node: string; type: string; index: number };
type Workflow = {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: Connection[][] }>;
  settings: Record<string, unknown>;
};

const wf = JSON.parse(readFileSync(fileURLToPath(new URL("../../n8n/sf-lead-create.json", import.meta.url)), "utf8")) as Workflow;
const byName = new Map(wf.nodes.map((n) => [n.name, n]));

function node(name: string): N8nNode {
  const n = byName.get(name);
  if (!n) throw new Error(`Missing node ${name}`);
  return n;
}

function jsCode(name: string): string {
  const c = node(name).parameters.jsCode;
  if (typeof c !== "string") throw new Error(`${name} has no jsCode`);
  return c;
}

function targets(name: string, output: number): string[] {
  return (wf.connections[name]?.main[output] ?? []).map((c) => c.node);
}

function ifExpression(name: string): string {
  const p = node(name).parameters as { conditions: { conditions: { leftValue: string }[] } };
  return p.conditions.conditions[0].leftValue;
}

/** Stand-in for n8n's $(): data of nodes that ran; unexecuted nodes throw, like n8n. */
function dollar(ran: Record<string, unknown>) {
  return (name: string) => {
    if (!(name in ran)) throw new Error(`Node '${name}' has not been executed`);
    return { first: () => ({ json: ran[name] }) };
  };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

type Item = { json: Record<string, unknown> };

async function runCode(name: string, ran: Record<string, unknown>, input: unknown = {}): Promise<Record<string, unknown>> {
  const fn = new AsyncFunction("$", "$input", "$env", "require", jsCode(name));
  const out = (await fn.call({}, dollar(ran), { first: () => ({ json: input }) }, {}, () => {
    throw new Error("require is not available here");
  })) as Item[];
  expect(out).toHaveLength(1);
  return out[0].json;
}

/** Renders an n8n "={{ ... }}" parameter with the given node data. */
function render(template: string, ran: Record<string, unknown>): string {
  expect(template.startsWith("=")).toBe(true);
  return template.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr: string) => String(new Function("$", `return (${expr});`)(dollar(ran))));
}

const SECRET = "n8n-test-secret";
const BOOKING = "11111111-1111-4111-8111-111111111111";
const LEAD = "00QHp00000AbCdEIAA";
const LEAD2 = "00QHp00000ZyXwVIAA";
const ISO = "001Hp00002abcdeIAA";

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: BOOKING,
    bookingId: BOOKING,
    mode: "match_or_create",
    isReschedule: false,
    lead: { FirstName: "Ana", LastName: "Ruiz", Email: "Ana@Example.com", Company: "Ruiz Bakery", Phone: "+13055550100", csbs__ISO__c: ISO },
    owner: { mode: "assigned_host", ownerEmail: "rep@bigthinkcapital.com" },
    autoAssign: false,
    meeting: {
      startUtc: "2026-10-05T14:00:00Z",
      endUtc: "2026-10-05T14:30:00Z",
      eventTypeName: "Consult",
      hostEmail: "rep@bigthinkcapital.com",
      hostName: "Rep One",
      isReschedule: false,
    },
    options: { createTask: false, createNote: false, setMeetingBookedFields: false },
    noteText: "Two trucks",
    sourceLabel: "Acme Partners BTC Scheduler",
    mobilePhone: "+13055550100",
    isoName: "Acme Partners",
    source: "btc-scheduler",
    ...over,
  };
}

async function verify(body: Record<string, unknown>, opts: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = "sha256=" + createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex");
  const fn = new AsyncFunction("$", "$input", "$env", "require", jsCode("Verify Signature"));
  const out = (await fn.call(
    { helpers: { getBinaryDataBuffer: async () => Buffer.from(raw, "utf8") } },
    dollar({}),
    { first: () => ({ json: { headers: { "x-btc-timestamp": ts, "x-btc-signature": sig, "idempotency-key": String(body.bookingId) } }, binary: { data: {} } }) },
    { BTC_SCHEDULER_SIGNING_SECRET: SECRET },
    (m: string) => {
      if (m !== "crypto") throw new Error(`unexpected require(${m})`);
      return nodeCrypto;
    },
  )) as Item[];
  return out[0].json as { ok: boolean; httpCode?: number; response?: { error: string }; inviteeEmail?: string | null; inviteeEmailEsc?: string | null; payload?: Record<string, unknown> };
}

describe("n8n/sf-lead-create.json: structure", () => {
  it("is an importable workflow with a consistent node graph", () => {
    expect(wf.name).toBe("BTC Scheduler - SF Lead Create");
    expect(wf.settings).toMatchObject({ executionOrder: "v1" });

    const names = wf.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    const ids = wf.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of wf.nodes) {
      expect(n.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(n.position).toHaveLength(2);
      expect(n.position.every((v) => Number.isFinite(v))).toBe(true);
    }
    const positions = wf.nodes.map((n) => n.position.join(","));
    expect(new Set(positions).size).toBe(positions.length);

    // The same node type versions as the rest of the file (and the poller workflow).
    const VERSIONS: Record<string, number> = {
      "n8n-nodes-base.webhook": 2,
      "n8n-nodes-base.code": 2,
      "n8n-nodes-base.if": 2.2,
      "n8n-nodes-base.redis": 1,
      "n8n-nodes-base.executeWorkflow": 1.2,
      "n8n-nodes-base.httpRequest": 4.3,
      "n8n-nodes-base.respondToWebhook": 1.1,
      "n8n-nodes-base.stickyNote": 1,
    };
    for (const n of wf.nodes) expect(VERSIONS[n.type], `${n.name} (${n.type})`).toBe(n.typeVersion);

    // Every connection source and target exists, and every node is reachable from the webhook.
    for (const [src, conn] of Object.entries(wf.connections)) {
      expect(byName.has(src), src).toBe(true);
      for (const output of conn.main) {
        for (const c of output) {
          expect(byName.has(c.node), `${src} -> ${c.node}`).toBe(true);
          expect(c).toMatchObject({ type: "main", index: 0 });
        }
      }
    }
    const seen = new Set<string>(["Lead Webhook"]);
    const queue = ["Lead Webhook"];
    while (queue.length) {
      for (const output of wf.connections[queue.shift()!]?.main ?? []) {
        for (const c of output) {
          if (seen.has(c.node)) continue;
          seen.add(c.node);
          queue.push(c.node);
        }
      }
    }
    const unreachable = wf.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote" && !seen.has(n.name)).map((n) => n.name);
    expect(unreachable).toEqual([]);

    // IF nodes have both branches wired.
    for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.if")) {
      expect(wf.connections[n.name]?.main, n.name).toHaveLength(2);
      expect(targets(n.name, 0).length, `${n.name} true`).toBeGreaterThan(0);
      expect(targets(n.name, 1).length, `${n.name} false`).toBeGreaterThan(0);
    }
  });

  it("calls the token broker and the shared Meeting Booked writer", () => {
    expect((node("Get SF Token").parameters.workflowId as { value: string }).value).toBe("7wen5ULQg7DBlCvC");
    const writer = node("Write Meeting Booked");
    expect(writer.type).toBe("n8n-nodes-base.executeWorkflow");
    expect(writer.parameters).toMatchObject({
      workflowId: { __rl: true, value: "yVjvBOx5E3Zc36rX", mode: "id" },
      mode: "each",
      options: { waitForSubWorkflow: true },
    });
    // Passthrough: no input schema, so the item from Build Writer Input is sent as is.
    expect(writer.parameters.workflowInputs).toEqual({ mappingMode: "defineBelow", value: {} });
    expect(writer.onError).toBe("continueRegularOutput");
    expect(targets("Build Writer Input", 0)).toEqual(["Write Meeting Booked"]);
    expect(targets("Write Meeting Booked", 0)).toEqual(["Remember Update?"]);
    for (const r of ["Idempotency Lookup", "Remember Result", "Remember Update"]) {
      expect(node(r).credentials?.redis.id).toBe("4i3m00SkLAc8SzwE");
    }
  });

  it("routes 'create' mode through the original insert path", () => {
    expect(targets("Get SF Token", 0)).toEqual(["Match Existing Lead?"]);
    expect(targets("Match Existing Lead?", 0)).toEqual(["Find Existing Lead"]);
    expect(targets("Match Existing Lead?", 1)).toEqual(["Owner By Email?"]);
    expect(ifExpression("Match Existing Lead?")).toContain("payload.mode !== 'create'");
    expect(targets("Find Existing Lead", 0)).toEqual(["Decide Action"]);
    expect(targets("Use Existing Lead?", 0)).toEqual(["Build Writer Input"]);
    expect(targets("Create New Lead?", 0)).toEqual(["Owner By Email?"]);
    expect(targets("Create New Lead?", 1)).toEqual(["Final Result"]);
    // The optional note and task run only in 'create' mode; the shared writer adds them otherwise.
    expect(ifExpression("Create Note?")).toContain("payload.mode === 'create'");
    expect(ifExpression("Create Task?")).toContain("payload.mode === 'create'");
    expect(ifExpression("Write Meeting Booked?")).toContain("payload.mode !== 'create'");
    expect(targets("Write Meeting Booked?", 1)).toEqual(["Final Result"]);
    // The insert itself is unchanged: never retried inside n8n, Sforce-Auto-Assign always sent.
    const create = node("Create Lead") as N8nNode & { retryOnFail?: boolean };
    expect(create.retryOnFail).toBeUndefined();
    expect(JSON.stringify(create.parameters)).toContain("Sforce-Auto-Assign");
  });

  it("compiles every Code node", () => {
    // The decision node has no await, so it compiles as a plain function body.
    expect(() => new Function("$", "$input", jsCode("Decide Action"))).not.toThrow();
    for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.code")) {
      expect(() => new AsyncFunction("$", "$input", "$env", "require", n.parameters.jsCode!), n.name).not.toThrow();
    }
  });
});

describe("n8n/sf-lead-create.json: Verify Signature and Find Existing Lead", () => {
  it("escapes the invitee's email for SOQL like the Calendly flow", async () => {
    const v = await verify(payload({ lead: { ...(payload().lead as object), Email: " O'Brien\\x@Example.com " } }));
    expect(v.ok).toBe(true);
    expect(v.inviteeEmail).toBe("o'brien\\x@example.com");
    // Backslash first, then the quote.
    expect(v.inviteeEmailEsc).toBe("o\\'brien\\\\x@example.com");

    const url = render(node("Find Existing Lead").parameters.url as string, {
      "Verify Signature": { sf_base: "https://bigthink.my.salesforce.com/services/data/v60.0", inviteeEmailEsc: v.inviteeEmailEsc },
    });
    const [base, query] = url.split("?q=");
    expect(base).toBe("https://bigthink.my.salesforce.com/services/data/v60.0/query");
    expect(decodeURIComponent(query)).toBe(
      "SELECT Id, Email, IsConverted, Status, OwnerId, csbs__ISO__c, CreatedDate FROM Lead WHERE Email = 'o\\'brien\\\\x@example.com' ORDER BY CreatedDate DESC LIMIT 5",
    );
  });

  it("validates the new fields and keeps old payloads in create mode", async () => {
    const legacy = payload();
    delete legacy.mode;
    delete legacy.isReschedule;
    const v = await verify(legacy);
    expect(v.ok).toBe(true);
    expect(v.payload).toMatchObject({ mode: "create", isReschedule: false });
    expect(v.inviteeEmailEsc).toBeNull();

    expect((await verify(payload({ mode: "upsert" }))).response?.error).toMatch(/mode/);
    expect((await verify(payload({ isReschedule: "yes" }))).response?.error).toMatch(/isReschedule/);
    expect((await verify(payload({ noteText: 5 }))).response?.error).toMatch(/noteText/);
    expect((await verify(payload({ lead: { LastName: "Ruiz", Company: "X" } }))).response?.error).toMatch(/lead\.Email/);
    const noHost = payload({ meeting: { ...(payload().meeting as object), hostEmail: null } });
    expect((await verify(noHost)).response?.error).toMatch(/meeting\.hostEmail/);
    // Create mode does not need the email or host for matching.
    expect((await verify(payload({ mode: "create", meeting: { ...(payload().meeting as object), hostEmail: null } }))).ok).toBe(true);

    const bad = await verify(payload(), { secret: "wrong" });
    expect(bad).toMatchObject({ ok: false, httpCode: 401 });
    const stale = await verify(payload(), { ts: Math.floor(Date.now() / 1000) - 600 });
    expect(stale).toMatchObject({ ok: false, httpCode: 401 });
  });
});

describe("n8n/sf-lead-create.json: Decide Action", () => {
  const decide = (p: Record<string, unknown>, lookup: unknown) => runCode("Decide Action", { "Verify Signature": { payload: p } }, lookup);
  const found = (...records: unknown[]) => ({ statusCode: 200, body: { totalSize: records.length, done: true, records } });
  const open = (Id: string, iso: string | null = ISO) => ({ Id, Email: "ana@example.com", IsConverted: false, Status: "Open", csbs__ISO__c: iso });
  const converted = (Id: string) => ({ Id, Email: "ana@example.com", IsConverted: true, Status: "Converted", csbs__ISO__c: null });

  it("updates the newest open Lead and records the existing ISO", async () => {
    const d = await decide(payload(), found(converted(LEAD2), open(LEAD, "001Hp00002zzzzzIAA")));
    expect(d).toMatchObject({ action: "update", created: false, leadId: LEAD, existingIso: "001Hp00002zzzzzIAA", effective_mode: "create" });
    expect((await decide(payload({ mode: "update_only" }), found(open(LEAD)))).action).toBe("update");
  });

  it("skips a converted Lead instead of creating a duplicate", async () => {
    const d = await decide(payload(), found(converted(LEAD2)));
    expect(d).toMatchObject({ action: "skip", reason: "converted_lead", matchedConvertedId: LEAD2 });
    expect(d.message).toBe("Existing CONVERTED lead found - not creating a duplicate");
  });

  it("creates only in match_or_create mode and never on a reschedule", async () => {
    expect(await decide(payload(), found())).toMatchObject({ action: "create", created: true, effective_mode: "create" });
    expect(await decide(payload({ mode: "update_only" }), found())).toMatchObject({ action: "skip", reason: "no_open_lead", effective_mode: "update" });
    expect(await decide(payload({ isReschedule: true }), found())).toMatchObject({
      action: "skip",
      reason: "reschedule_no_open_lead",
      effective_mode: "update",
      is_reschedule: true,
    });
    expect(await decide(payload({ isReschedule: true }), found(open(LEAD)))).toMatchObject({ action: "update", leadId: LEAD, is_reschedule: true });
  });

  it("classifies lookup failures", async () => {
    expect(await decide(payload(), { statusCode: 503, body: "unavailable" })).toMatchObject({ action: "error", retryable: true });
    expect(await decide(payload(), { error: { message: "ETIMEDOUT" } })).toMatchObject({ action: "error", retryable: true });
    const malformed = await decide(payload(), { statusCode: 400, body: [{ errorCode: "MALFORMED_QUERY", message: "bad" }] });
    expect(malformed).toMatchObject({ action: "error", retryable: false });
    expect(malformed.error).toMatch(/MALFORMED_QUERY/);
    expect(await decide(payload(), { statusCode: 401, body: [{ errorCode: "INVALID_SESSION_ID" }] })).toMatchObject({ action: "error", retryable: true });
  });
});

describe("n8n/sf-lead-create.json: Build Writer Input", () => {
  const verified = (p: Record<string, unknown>) => ({ payload: p, inviteeEmail: "ana@example.com" });

  it("maps the BTC payload to the shared writer contract for a matched Lead", async () => {
    const decision = { action: "update", created: false, leadId: LEAD, existingIso: "001Hp00002zzzzzIAA", effective_mode: "update", is_reschedule: true };
    const input = await runCode("Build Writer Input", { "Verify Signature": verified(payload({ isReschedule: true })), "Decide Action": decision });
    expect(input).toEqual({
      lead_id: LEAD,
      rep_email: "rep@bigthinkcapital.com",
      rep_name: "Rep One",
      iso_id: ISO,
      iso_name: "Acme Partners",
      source_label: "Acme Partners BTC Scheduler",
      set_owner: true,
      start_time: "2026-10-05T14:00:00Z",
      end_time: "2026-10-05T14:30:00Z",
      event_type: "Consult",
      calendly_uri: `btc-scheduler:${BOOKING}`,
      invitee_name: "Ana Ruiz",
      invitee_email: "ana@example.com",
      invitee_phone: "+13055550100",
      invitee_company: "Ruiz Bakery",
      mobile_phone: "+13055550100",
      note_text: "Two trucks",
      write_calendar_event: false,
      unmapped: false,
      effective_mode: "update",
      existing_iso: "001Hp00002zzzzzIAA",
      is_reschedule: true,
      created: false,
    });
  });

  it("uses the inserted Lead and the owner mode for a created Lead", async () => {
    const p = payload({ owner: { mode: "fixed", ownerId: "005Hp00000AbCdEIAA" }, noteText: null, isoName: null, mobilePhone: null });
    const input = await runCode("Build Writer Input", {
      "Verify Signature": verified(p),
      "Decide Action": { action: "create", created: true, effective_mode: "create" },
      "Classify Lead Response": { status: "created", leadId: LEAD2 },
    });
    expect(input).toMatchObject({ lead_id: LEAD2, created: true, set_owner: false, existing_iso: "", note_text: "", iso_name: "", mobile_phone: "" });
  });
});

describe("n8n/sf-lead-create.json: Final Result and Replay", () => {
  const ok = { ok: true, skipped: false, problems: [], patch_ok: true, note_ok: true, task_ok: true, lead_id: LEAD, rep_resolved: true };
  const finalFor = (ran: Record<string, unknown>) => runCode("Final Result", { "Idempotency Lookup": {}, ...ran });
  const verified = (over: Record<string, unknown> = {}) => ({ payload: payload(over) });

  it("reports an updated Lead with the writer's problems", async () => {
    const r = await finalFor({
      "Verify Signature": verified(),
      "Decide Action": { action: "update", leadId: LEAD },
      "Write Meeting Booked": { ...ok, task_ok: false, problems: ["Lead_Log_Detail__c insert failed"] },
      "Remember Update": {},
    });
    expect(r).toEqual({
      httpCode: 200,
      response: {
        status: "updated",
        leadId: LEAD,
        matchedRecordId: null,
        error: null,
        retryable: false,
        problems: ["Lead_Log_Detail__c insert failed", "Task create failed"],
      },
    });
  });

  it("reports skips, lookup errors and writer failures", async () => {
    const skipped = await finalFor({ "Verify Signature": verified(), "Decide Action": { action: "skip", reason: "converted_lead", matchedConvertedId: LEAD2 } });
    expect(skipped).toMatchObject({ httpCode: 200, response: { status: "skipped", leadId: null, matchedConvertedId: LEAD2, reason: "converted_lead", problems: [] } });

    const lookup = await finalFor({ "Verify Signature": verified(), "Decide Action": { action: "error", error: "Lead lookup failed: HTTP_503", retryable: true } });
    expect(lookup).toMatchObject({ httpCode: 503, response: { status: "error", retryable: true } });

    const crashed = await finalFor({ "Verify Signature": verified(), "Decide Action": { action: "update", leadId: LEAD }, "Write Meeting Booked": { error: "Workflow does not exist" } });
    expect(crashed).toMatchObject({ httpCode: 503, response: { status: "error", retryable: true } });
    expect((crashed.response as { error: string }).error).toMatch(/Meeting Booked writer failed/);

    const writerSkipped = await finalFor({
      "Verify Signature": verified(),
      "Decide Action": { action: "update", leadId: LEAD },
      "Write Meeting Booked": { ok: false, skipped: true, reason: "missing rep_email" },
    });
    expect(writerSkipped).toMatchObject({ httpCode: 422, response: { status: "error", retryable: false } });
  });

  it("adds the writer's result to a Lead created in match_or_create mode", async () => {
    const r = await finalFor({
      "Verify Signature": verified(),
      "Decide Action": { action: "create" },
      "Classify Lead Response": { status: "created", leadId: LEAD, matchedRecordId: null, error: null, retryable: false, problems: [] },
      "Remember Result": {},
      "Write Meeting Booked": { ...ok, note_ok: false },
    });
    expect(r).toMatchObject({ httpCode: 200, response: { status: "created", leadId: LEAD, problems: ["Note create failed"] } });

    const dup = await finalFor({
      "Verify Signature": verified(),
      "Decide Action": { action: "create" },
      "Classify Lead Response": { status: "duplicate", leadId: null, matchedRecordId: "006Hp00000AbCdE", error: "Duplicate phone", retryable: false, problems: [] },
      "Remember Result": {},
    });
    expect(dup).toMatchObject({ httpCode: 200, response: { status: "duplicate", matchedRecordId: "006Hp00000AbCdE", problems: [] } });
  });

  it("keeps the 'create' mode result unchanged", async () => {
    const p = { mode: "create", options: { createTask: true, createNote: true, setMeetingBookedFields: false }, campaignId: "701Hp000001AbCdIAK" };
    const r = await finalFor({
      "Verify Signature": verified(p),
      "Classify Lead Response": { status: "created", leadId: LEAD, matchedRecordId: null, error: null, retryable: false, problems: ["Owner lookup failed; Lead created with the default owner"] },
      "Remember Result": {},
      "Add Campaign Member": { statusCode: 201, body: { id: "00vHp000001AbCd" } },
      "Create ContentNote": { statusCode: 400, body: [] },
      "Create Task": { statusCode: 201, body: { id: "00THp000001AbCd" } },
    });
    expect(r).toEqual({
      httpCode: 200,
      response: {
        status: "created",
        leadId: LEAD,
        matchedRecordId: null,
        error: null,
        retryable: false,
        problems: ["Owner lookup failed; Lead created with the default owner", "Note create failed"],
      },
    });
  });

  it("replays stored results without calling Salesforce", async () => {
    const replay = (cached: unknown) => runCode("Replay Stored Result", {}, { cached: JSON.stringify(cached) });
    expect(await replay({ status: "created", leadId: LEAD })).toMatchObject({ httpCode: 200, response: { status: "existing", leadId: LEAD } });
    expect(await replay({ status: "updated", leadId: LEAD })).toMatchObject({ httpCode: 200, response: { status: "updated", leadId: LEAD } });
    expect(await replay({ status: "duplicate", leadId: null, error: "Duplicate rule matched" })).toMatchObject({ response: { status: "duplicate" } });
  });
});
