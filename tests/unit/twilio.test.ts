import { describe, expect, it } from "vitest";
import { createTwilioClient, twilioSignature, TWILIO_TIMEOUT_MS, validTwilioSignature } from "@/server/sms/twilio";
import { PermanentJobError, RetryAfterError } from "@/server/jobs/types";

const SID = "AC" + "0123456789abcdef".repeat(2);
const TOKEN = "f".repeat(32);

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { calls, fetchImpl };
}

const client = (f: ReturnType<typeof fakeFetch>["fetchImpl"]) => createTwilioClient({ accountSid: SID, authToken: TOKEN, fromNumber: "+18885550100", fetch: f });

describe("twilioSignature", () => {
  it("matches Twilio's documented example", () => {
    // Example from Twilio's request validation docs and the twilio-node test suite.
    const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
    expect(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("accepts a signature for any candidate URL and rejects others", () => {
    const params = new URLSearchParams({ Body: "STOP", From: "+12125550142", To: "+18885550100" });
    const good = twilioSignature(TOKEN, "https://book.bigthinkcapital.com/api/sms/twilio", params);
    expect(validTwilioSignature(TOKEN, good, ["https://internal.example/api/sms/twilio", "https://book.bigthinkcapital.com/api/sms/twilio"], params)).toBe(true);
    expect(validTwilioSignature(TOKEN, good, ["https://btcbookings.vercel.app/api/sms/twilio"], params)).toBe(false);
    expect(validTwilioSignature("e".repeat(32), good, ["https://book.bigthinkcapital.com/api/sms/twilio"], params)).toBe(false);
    expect(validTwilioSignature(TOKEN, null, ["https://book.bigthinkcapital.com/api/sms/twilio"], params)).toBe(false);
    // A changed parameter breaks the signature.
    const tampered = new URLSearchParams({ Body: "START", From: "+12125550142", To: "+18885550100" });
    expect(validTwilioSignature(TOKEN, good, ["https://book.bigthinkcapital.com/api/sms/twilio"], tampered)).toBe(false);
  });
});

describe("Twilio client", () => {
  it("posts the message form to the account's Messages resource with basic auth", async () => {
    const f = fakeFetch(201, { sid: "SM123", status: "queued", error_code: null });
    expect(await client(f.fetchImpl).sendMessage({ to: "+12125550142", content: "Hello & bye" })).toEqual({ messageHandle: "SM123", status: "queued", skipped: false });
    expect(f.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0].init.body)))).toEqual({ To: "+12125550142", From: "+18885550100", Body: "Hello & bye" });
  });

  it("retries later on HTTP 429 and error 20429", async () => {
    const limited = await client(fakeFetch(429, { code: 20429 }, { "retry-after": "7" }).fetchImpl)
      .sendMessage({ to: "+12125550142", content: "x" })
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RetryAfterError);
    expect((limited as RetryAfterError).retryAfterSeconds).toBe(7);
    const code = await client(fakeFetch(400, { code: 20429 }).fetchImpl)
      .sendMessage({ to: "+12125550142", content: "x" })
      .catch((e: unknown) => e);
    expect(code).toBeInstanceOf(RetryAfterError);
  });

  it("retries server errors with the worker's backoff", async () => {
    const err = await client(fakeFetch(503, { code: 20500 }).fetchImpl)
      .sendMessage({ to: "+12125550142", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(err).not.toBeInstanceOf(RetryAfterError);
  });

  it("fails permanently on client errors and failed messages, never exposing the token", async () => {
    for (const [status, body] of [
      [400, { code: 21211, message: "Invalid 'To' Phone Number" }],
      [400, { code: 21610, message: "Attempt to send to unsubscribed recipient" }],
      [401, { code: 20003, message: "Authenticate" }],
      [201, { sid: "SM9", status: "failed", error_code: 30007 }],
    ] as const) {
      const err = await client(fakeFetch(status, body).fetchImpl)
        .sendMessage({ to: "+12125550142", content: "x" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentJobError);
      expect((err as Error).message).toMatch(/^Twilio http_\d+ code_\d+$/);
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it("times out and reports transport failures without details", async () => {
    expect(TWILIO_TIMEOUT_MS).toBe(15_000);
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    const slow = createTwilioClient({ accountSid: SID, authToken: TOKEN, fromNumber: "+18885550100", fetch: hang, timeoutMs: 10 });
    await expect(slow.sendMessage({ to: "+12125550142", content: "x" })).rejects.toThrow("Twilio request timed out");
    const down = createTwilioClient({ accountSid: SID, authToken: TOKEN, fromNumber: "+18885550100", fetch: async () => Promise.reject(new Error(`connect failed ${TOKEN}`)) });
    await expect(down.sendMessage({ to: "+12125550142", content: "x" })).rejects.toThrow(/^Twilio request failed$/);
  });
});
