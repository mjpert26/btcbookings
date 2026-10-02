import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/server/env";

type HeaderLike = { get(name: string): string | null };

/** Client IP as Vercel reports it. Only used hashed; raw IPs are never stored. */
export function clientIp(h: HeaderLike): string {
  return (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip") || "0.0.0.0";
}

export function hashIp(h: HeaderLike): string {
  return createHash("sha256").update(`${env().IP_HASH_SALT}:${clientIp(h)}`).digest("hex").slice(0, 32);
}
