import { configureGraph } from "@/server/graph/client";

/**
 * In-memory stand-in for Microsoft Graph. Register responders per method and URL pattern;
 * each responder in a list is used once in order and the last one repeats. Unmatched
 * requests fail the test with a 599 so they are easy to spot.
 */
export type MockCall = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Responder = Response | ((call: MockCall) => Response | Promise<Response>);
type Route = { method: string; pattern: RegExp; responders: Responder[]; used: number };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function graphError(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message: `${code} message` } }, headers);
}

export class GraphMock {
  calls: MockCall[] = [];
  sleeps: number[] = [];
  tokenRequests: { forceRefresh: boolean }[] = [];
  private routes: Route[] = [];

  on(method: string, pattern: RegExp, ...responders: Responder[]): this {
    this.routes.push({ method: method.toUpperCase(), pattern, responders, used: 0 });
    return this;
  }

  callsTo(method: string, pattern: RegExp): MockCall[] {
    return this.calls.filter((c) => c.method === method.toUpperCase() && pattern.test(c.url));
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: MockCall = {
      method: (init.method ?? "GET").toUpperCase(),
      url: input,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    // Routes registered later take precedence, so tests can override defaults.
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i];
      if (r.method !== call.method || !r.pattern.test(call.url)) continue;
      const responder = r.responders[Math.min(r.used, r.responders.length - 1)];
      r.used++;
      const res = typeof responder === "function" ? await responder(call) : responder.clone();
      return res;
    }
    return json(599, { error: { code: "unmocked", message: `${call.method} ${call.url}` } });
  };
}

/** Points the Graph client at a fresh mock. Tokens are "token-1", or "token-2" after a forced refresh. */
export function installGraphMock(): GraphMock {
  const mock = new GraphMock();
  configureGraph({
    fetch: mock.fetch,
    tokenProvider: async (_userId, { forceRefresh }) => {
      mock.tokenRequests.push({ forceRefresh });
      return forceRefresh ? "token-2" : "token-1";
    },
    sleep: async (ms) => {
      mock.sleeps.push(ms);
    },
  });
  return mock;
}

export function resetGraph(): void {
  configureGraph(null);
}
