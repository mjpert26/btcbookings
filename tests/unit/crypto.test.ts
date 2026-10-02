import { describe, expect, it } from "vitest";
import { decryptWith, encryptWith, parseKeyRing } from "@/server/crypto/aes";
import { computeSignature, signRequest, verifySignature } from "@/server/crypto/hmac";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");

describe("AES-256-GCM", () => {
  const ring = parseKeyRing(`a:${k1},b:${k2}`, "a");

  it("round-trips and uses a fresh IV every time", () => {
    const x = encryptWith(ring, "refresh-token-value", "user-1");
    const y = encryptWith(ring, "refresh-token-value", "user-1");
    expect(x).not.toEqual(y);
    expect(decryptWith(ring, x, "user-1")).toBe("refresh-token-value");
    expect(x).not.toContain("refresh-token-value");
  });

  it("rejects tampered ciphertext", () => {
    const x = encryptWith(ring, "secret");
    const parts = x.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptWith(ring, parts.join("."))).toThrow();
  });

  it("rejects a ciphertext bound to another user (AAD)", () => {
    const x = encryptWith(ring, "secret", "user-1");
    expect(() => decryptWith(ring, x, "user-2")).toThrow();
  });

  it("decrypts values written with an older key after rotation", () => {
    const old = encryptWith(parseKeyRing(`b:${k2}`, "b"), "legacy");
    const rotated = parseKeyRing(`a:${k1},b:${k2}`, "a");
    expect(decryptWith(rotated, old)).toBe("legacy");
    expect(encryptWith(rotated, "new").split(".")[1]).toBe("a");
  });

  it("validates key length and active key", () => {
    expect(() => parseKeyRing(`a:${Buffer.alloc(16).toString("base64")}`, "a")).toThrow(/32 bytes/);
    expect(() => parseKeyRing(`a:${k1}`, "z")).toThrow(/Active key/);
  });
});

describe("HMAC request signing", () => {
  const secret = "shared-secret";
  const body = JSON.stringify({ bookingId: "b1" });

  it("verifies a signature it produced", () => {
    const now = 1_790_000_000;
    const h = signRequest(secret, body, now);
    expect(verifySignature(secret, body, h["x-btc-timestamp"], h["x-btc-signature"], now)).toEqual({ ok: true });
  });

  it("rejects a modified body, a wrong secret, and missing headers", () => {
    const now = 1_790_000_000;
    const h = signRequest(secret, body, now);
    expect(verifySignature(secret, body + " ", h["x-btc-timestamp"], h["x-btc-signature"], now).ok).toBe(false);
    expect(verifySignature("other", body, h["x-btc-timestamp"], h["x-btc-signature"], now).ok).toBe(false);
    expect(verifySignature(secret, body, null, h["x-btc-signature"], now)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects replays outside the 5 minute window", () => {
    const ts = 1_790_000_000;
    const sig = computeSignature(secret, String(ts), body);
    expect(verifySignature(secret, body, String(ts), sig, ts + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(secret, body, String(ts), sig, ts - 301)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(secret, body, String(ts), sig, ts + 299).ok).toBe(true);
  });
});
