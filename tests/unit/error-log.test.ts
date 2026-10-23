import { describe, expect, it } from "vitest";
import {
  describeError,
  fingerprint,
  isFrameworkSignal,
  LIMITS,
  normalizeMessage,
  normalizeRoute,
  prepareError,
  sanitizeContext,
  sanitizeText,
} from "@/server/errors/sanitize";
import { requestErrorSource } from "@/server/errors/request";

describe("sanitizeText", () => {
  it("redacts bearer and basic credentials", () => {
    expect(sanitizeText("Authorization: Bearer abc.def-ghi_123")).not.toContain("abc.def");
    expect(sanitizeText("bearer abcdef123456")).toBe("bearer [redacted]");
    expect(sanitizeText("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [redacted]");
  });

  it("redacts BTC API keys and OAuth tokens", () => {
    const out = sanitizeText("bad key btc_pat_AbC123xyz and btc_at_Q-1_z and btc_rt_zzz999");
    expect(out).toBe("bad key btc_pat_[redacted] and btc_at_[redacted] and btc_rt_[redacted]");
  });

  it("redacts JWT-like strings and Slack tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(sanitizeText(`token was ${jwt}`)).toBe("token was [jwt]");
    expect(sanitizeText("xoxb-123-456-abcdef")).toBe("xox-[redacted]");
  });

  it("redacts email addresses, phone numbers and long digit runs", () => {
    expect(sanitizeText("duplicate key (email)=(jane.doe+x@example.co.uk)")).toBe("duplicate key (email)=([email])");
    expect(sanitizeText("call +1 (555) 123-4567 now")).toBe("call [phone] now");
    expect(sanitizeText("call 555.123.4567")).toBe("call [phone]");
    expect(sanitizeText("account 123456789012 failed")).toBe("account [number] failed");
    // Short numbers such as status codes and line numbers stay.
    expect(sanitizeText("Graph returned 503 after 2 tries at file.ts:120:7")).toBe("Graph returned 503 after 2 tries at file.ts:120:7");
  });

  it("redacts cookie headers and secret-named pairs", () => {
    expect(sanitizeText("cookie: btc_session=abc; other=1")).toBe("cookie: [redacted]");
    expect(sanitizeText('{"password":"hunter2","name":"x"}')).toBe('{"password":"[redacted]","name":"x"}');
    expect(sanitizeText("client_secret=s3cr3t&grant_type=refresh_token")).toBe("client_secret=[redacted]&grant_type=refresh_token");
    expect(sanitizeText("GET /callback?code=abc123&state=xyz")).toBe("GET /callback?code=[redacted]&state=[redacted]");
  });
});

describe("sanitizeContext", () => {
  it("drops secret-named keys and redacts strings", () => {
    const out = sanitizeContext({
      jobKind: "email_send",
      attempt: 3,
      token: "abc",
      authorization: "Bearer x",
      email: "a@b.com",
      payload: { to: "a@b.com" },
      note: "sent to someone@bigthinkcapital.com",
      nested: { deeper: { apiKey: "k", ok: true } },
    });
    expect(out).toEqual({
      jobKind: "email_send",
      attempt: 3,
      token: "[redacted]",
      authorization: "[redacted]",
      email: "[redacted]",
      payload: "[redacted]",
      note: "sent to [email]",
      nested: { deeper: { apiKey: "[redacted]", ok: true } },
    });
  });

  it("handles cycles, depth, long arrays and non-JSON values", () => {
    const a: Record<string, unknown> = { n: BigInt(1), when: new Date("2026-10-23T00:00:00Z"), fn: () => 1 };
    a.self = a;
    a.list = Array.from({ length: 25 }, (_, i) => i);
    a.deep = { l1: { l2: { l3: { l4: 1 } } } };
    const out = sanitizeContext(a);
    expect(out.n).toBe("1");
    expect(out.when).toBe("2026-10-23T00:00:00.000Z");
    expect(out.fn).toBe("[function]");
    expect(out.self).toBe("[circular]");
    expect((out.list as unknown[]).length).toBe(LIMITS.contextArray + 1);
    expect(out.deep).toEqual({ l1: { l2: { l3: "[nested]" } } });
  });

  it("limits the total size and rejects non-objects", () => {
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(400)]));
    expect(sanitizeContext(big)).toMatchObject({ _truncated: true });
    expect(sanitizeContext("text")).toEqual({});
    expect(sanitizeContext([1, 2])).toEqual({});
    expect(sanitizeContext(null)).toEqual({});
  });
});

describe("normalizeRoute", () => {
  it("removes query strings and identifier-like segments", () => {
    expect(normalizeRoute("/b/Zx9kQ2mP7rT4vB8nL1cD5fG3/manage?lang=es")).toBe("/b/:id/manage");
    expect(normalizeRoute("/bookings/0b7e6c1a-2f7d-4d8e-9a51-3c2b1d0e9f8a")).toBe("/bookings/:id");
    expect(normalizeRoute("/api/v1/bookings/42#x")).toBe("/api/v1/bookings/:id");
    expect(normalizeRoute("/u/jane@example.com")).toBe("/u/:id");
  });

  it("keeps route file patterns and readable slugs", () => {
    expect(normalizeRoute("/(public)/b/[token]/page")).toBe("/(public)/b/[token]/page");
    expect(normalizeRoute("/mike-perticone/intro-call")).toBe("/mike-perticone/intro-call");
  });
});

describe("fingerprint", () => {
  it("groups messages that differ only in numbers and ids", () => {
    const a = fingerprint({ source: "job", route: "graph_event_create", errorName: "Error", message: "timeout after 31 ms for 0b7e6c1a-2f7d-4d8e-9a51-3c2b1d0e9f8a" });
    const b = fingerprint({ source: "job", route: "graph_event_create", errorName: "Error", message: "timeout after 4500 ms for 11111111-2222-4333-8444-555555555555" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates different sources, routes, names and messages", () => {
    const base = { source: "page" as const, route: "/dashboard", errorName: "TypeError", message: "x is undefined" };
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, source: "action" })).not.toBe(fp);
    expect(fingerprint({ ...base, route: "/bookings" })).not.toBe(fp);
    expect(fingerprint({ ...base, errorName: "RangeError" })).not.toBe(fp);
    expect(fingerprint({ ...base, message: "y is undefined" })).not.toBe(fp);
  });

  it("normalizes whitespace and hex identifiers", () => {
    expect(normalizeMessage("event  AAMkAGI2ZjVh0123456789abcdef  missing\n")).toBe("event <id> missing");
    expect(normalizeMessage("lead 00Q5e00000AbCdEFG not found")).toBe("lead <id> not found");
    expect(normalizeMessage("etag deadbeefdeadbeef changed")).toBe("etag <hex> changed");
  });
});

describe("describeError and prepareError", () => {
  it("reads name, frames, digest and code", () => {
    const err = Object.assign(new TypeError("bad thing"), { digest: "12345", code: "23505" });
    const d = describeError(err);
    expect(d.name).toBe("TypeError");
    expect(d.message).toBe("bad thing");
    expect(d.stack).toMatch(/^\s+at /);
    expect(d.stack).not.toContain("bad thing");
    expect(d.digest).toBe("12345");
    expect(d.code).toBe("23505");
  });

  it("handles thrown non-errors", () => {
    expect(describeError("plain")).toMatchObject({ name: "NonError", message: "plain" });
    expect(describeError({ a: 1 })).toMatchObject({ name: "NonError", message: '{"a":1}' });
    expect(describeError(undefined)).toMatchObject({ name: "NonError" });
  });

  it("sanitizes and truncates every field", () => {
    const err = new Error(`failed for jane@example.com with btc_pat_secret123 ${"x".repeat(3000)}`);
    const row = prepareError(err, { source: "api", route: "/api/v1/bookings/123?token=abc", method: "post", context: { requestBody: "{}", bookingId: "b1" } });
    expect(row.message.length).toBeLessThanOrEqual(LIMITS.message);
    expect(row.message).toContain("[email]");
    expect(row.message).toContain("btc_pat_[redacted]");
    expect(row.message).not.toContain("jane@");
    expect(row.route).toBe("/api/v1/bookings/:id");
    expect(row.method).toBe("POST");
    expect(row.context).toEqual({ requestBody: "[redacted]", bookingId: "b1" });
  });
});

describe("isFrameworkSignal", () => {
  it("recognizes Next.js redirect and not-found errors", () => {
    expect(isFrameworkSignal(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }))).toBe(true);
    expect(isFrameworkSignal(Object.assign(new Error("x"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }))).toBe(true);
    expect(isFrameworkSignal(Object.assign(new Error("x"), { digest: "2938471" }))).toBe(false);
    expect(isFrameworkSignal(new Error("x"))).toBe(false);
    expect(isFrameworkSignal("x")).toBe(false);
  });
});

describe("requestErrorSource", () => {
  it("maps route types and paths to sources", () => {
    expect(requestErrorSource("render", "/dashboard")).toBe("page");
    expect(requestErrorSource("action", "/admin/users")).toBe("action");
    expect(requestErrorSource("route", "/api/cron/jobs")).toBe("cron");
    expect(requestErrorSource("route", "/api/v1/bookings?x=1")).toBe("api");
    expect(requestErrorSource("route", "/mcp")).toBe("mcp");
    expect(requestErrorSource("route", "/api/public/book")).toBe("route");
    expect(requestErrorSource("proxy", "/dashboard")).toBe("route");
  });
});
