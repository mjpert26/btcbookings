import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/server/env";

/**
 * AES-256-GCM encryption for secrets at rest (Graph tokens, delta links).
 *
 * Format: v1.<kid>.<iv b64url>.<ciphertext b64url>.<tag b64url>
 * The key id allows rotation: new values use the active key, old values still decrypt.
 */
const VERSION = "v1";

type KeyRing = { activeKid: string; keys: Map<string, Buffer> };

let ring: KeyRing | null = null;

export function parseKeyRing(spec: string, activeKid: string): KeyRing {
  const keys = new Map<string, Buffer>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error("TOKEN_ENCRYPTION_KEYS entries must be kid:base64key");
    const kid = part.slice(0, idx);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error(`Invalid key id: ${kid}`);
    const key = Buffer.from(part.slice(idx + 1), "base64");
    if (key.length !== 32) throw new Error(`Key ${kid} must be 32 bytes, got ${key.length}`);
    keys.set(kid, key);
  }
  if (!keys.has(activeKid)) throw new Error(`Active key id ${activeKid} not found in TOKEN_ENCRYPTION_KEYS`);
  return { activeKid, keys };
}

function keyRing(): KeyRing {
  if (!ring) {
    const e = env();
    ring = parseKeyRing(e.TOKEN_ENCRYPTION_KEYS, e.TOKEN_ENCRYPTION_ACTIVE_KID);
  }
  return ring;
}

/** For tests only. */
export function resetKeyRing(): void {
  ring = null;
}

export function encryptWith(r: KeyRing, plaintext: string, aad = ""): string {
  const key = r.keys.get(r.activeKid)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, r.activeKid, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptWith(r: KeyRing, payload: string, aad = ""): string {
  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error("Unrecognized ciphertext format");
  const [, kid, ivB64, ctB64, tagB64] = parts;
  const key = r.keys.get(kid);
  if (!key) throw new Error(`Unknown encryption key id: ${kid}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Encrypts a secret. `aad` binds the ciphertext to a context such as a user id. */
export function encryptSecret(plaintext: string, aad = ""): string {
  return encryptWith(keyRing(), plaintext, aad);
}

export function decryptSecret(payload: string, aad = ""): string {
  return decryptWith(keyRing(), payload, aad);
}
