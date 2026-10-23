import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureFor, signatureHeader } from "@/server/webhooks/sign";
import { checkWebhookUrl, isBlockedAddress, resolvePublicUrl } from "@/server/webhooks/url";

describe("webhook signatures", () => {
  it("signs '<timestamp>.<body>' with HMAC-SHA256", () => {
    const body = '{"type":"booking.created"}';
    const expected = createHmac("sha256", "whsec_test").update(`1700000000.${body}`).digest("hex");
    expect(signatureFor("whsec_test", 1700000000, body)).toBe(expected);
    expect(signatureHeader("whsec_test", 1700000000, body)).toBe(`t=1700000000,v1=${expected}`);
    expect(signatureFor("whsec_other", 1700000000, body)).not.toBe(expected);
  });
});

describe("webhook URL checks", () => {
  it("accepts public HTTPS URLs", () => {
    expect(checkWebhookUrl("https://hooks.example.com/btc?x=1").ok).toBe(true);
    expect(checkWebhookUrl("https://93.184.216.34/hook").ok).toBe(true);
  });

  it.each([
    ["http://hooks.example.com/x", "must use https"],
    ["https://user:pw@hooks.example.com/x", "must not contain credentials"],
    ["https://hooks.example.com:8443/x", "must use the standard HTTPS port"],
    ["https://localhost/x", "must use a public host name"],
    ["https://intranet/x", "must use a public host name"],
    ["https://db.internal/x", "must use a public host name"],
    ["https://10.1.2.3/x", "points to a private or reserved address"],
    ["https://169.254.169.254/latest", "points to a private or reserved address"],
    ["https://[::1]/x", "points to a private or reserved address"],
    ["https://[::ffff:127.0.0.1]/x", "points to a private or reserved address"],
    ["not a url", "is not a valid URL"],
  ])("refuses %s", (url, reason) => {
    expect(checkWebhookUrl(url)).toEqual({ ok: false, reason });
  });

  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.0.0.1", "172.20.1.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "garbage"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isBlockedAddress(a), a).toBe(false);
  });

  it("refuses host names that resolve to private addresses", async () => {
    expect((await resolvePublicUrl("https://hooks.example.com/x", async () => ["93.184.216.34"])).ok).toBe(true);
    expect(await resolvePublicUrl("https://rebind.example.com/x", async () => ["93.184.216.34", "10.0.0.5"])).toEqual({
      ok: false,
      reason: "resolves to a private or reserved address",
    });
    expect(await resolvePublicUrl("https://gone.example.com/x", async () => { throw new Error("ENOTFOUND"); })).toEqual({
      ok: false,
      reason: "host name does not resolve",
    });
  });
});
