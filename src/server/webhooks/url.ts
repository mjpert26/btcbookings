import { BlockList, isIP } from "node:net";

/**
 * Destination checks for webhook URLs. Endpoints are configured by admins, but deliveries
 * still refuse anything that is not public HTTPS: no credentials in the URL, no internal
 * host names, and no address in a private, loopback, link-local or reserved range (checked
 * on the literal host and again on every DNS answer at delivery time). The delivery then
 * connects to a checked address (see pinnedFetch in jobs.ts), so a second DNS answer can
 * never redirect it.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// Ranges that embed or translate to IPv4 addresses (IPv4-compatible ::/96, SIIT
// ::ffff:0:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16, Teredo 2001::/32) are refused as a
// whole: they can reach internal IPv4 addresses and no webhook receiver needs them.
for (const [net, prefix] of [
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True when the address must not receive webhook traffic. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return blocked.check(address, "ipv4");
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    // BlockList checks the hex IPv4-mapped form (::ffff:7f00:1) against the IPv4 rules.
    return blocked.check(address, "ipv6");
  }
  return true;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Result of the delivery-time check. `addresses` are the checked DNS answers (empty for an
 * IP literal host); the delivery must connect to one of them and never resolve again.
 * `transient` marks a lookup failure that may succeed on a later attempt.
 */
export type ResolvedUrl =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string; transient?: boolean };

/** Host name of a URL without IPv6 brackets or one trailing dot, lower case. */
export function urlHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** Static checks on a webhook URL (no DNS). */
export function checkWebhookUrl(raw: string): UrlCheck {
  if (raw.length > 2000) return { ok: false, reason: "is too long" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "must use https" };
  if (url.username || url.password) return { ok: false, reason: "must not contain credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "must use the standard HTTPS port" };
  const host = urlHost(url);
  if (isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: "points to a private or reserved address" };
  } else if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    return { ok: false, reason: "must use a public host name" };
  }
  return { ok: true, url };
}

export type LookupFn = (hostname: string) => Promise<string[]>;

/** Lookup errors that mean the name does not exist, as opposed to a resolver problem. */
const NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "EAI_NONAME", "EAI_NODATA"]);

/** Static checks plus DNS: every resolved address must be public. */
export async function resolvePublicUrl(raw: string, lookup: LookupFn): Promise<ResolvedUrl> {
  const check = checkWebhookUrl(raw);
  if (!check.ok) return check;
  const host = urlHost(check.url);
  if (isIP(host)) return { ok: true, url: check.url, addresses: [] };
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && NOT_FOUND_CODES.has(code)) return { ok: false, reason: "host name does not resolve" };
    return { ok: false, reason: "host name lookup failed", transient: true };
  }
  if (!addresses.length) return { ok: false, reason: "host name does not resolve" };
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: "resolves to a private or reserved address" };
  return { ok: true, url: check.url, addresses };
}
