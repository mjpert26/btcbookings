import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://login.microsoftonline.com",
    ].join("; "),
  },
];

// The MCP server answers at "<MCP_BASE_URL>/mcp" and also at "<APP_BASE_URL>/mcp".
function mcpHost(): string | null {
  try {
    return process.env.MCP_BASE_URL ? new URL(process.env.MCP_BASE_URL).host : null;
  } catch {
    return null;
  }
}

// Former public hostnames of the app, comma separated (for example btcbookings.vercel.app).
function legacyHosts(): string[] {
  let appHost = "";
  try {
    appHost = new URL(process.env.APP_BASE_URL ?? "").host;
  } catch {
    return [];
  }
  return (process.env.APP_LEGACY_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h && h !== appHost && /^[a-z0-9.-]+(:\d+)?$/.test(h));
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return { beforeFiles: [{ source: "/mcp", destination: "/api/mcp" }], afterFiles: [], fallback: [] };
  },
  async redirects() {
    const app = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
    if (!app) return [];
    const rules: { source: string; has: { type: "host"; value: string }[]; destination: string; permanent: boolean }[] = [];
    // A browser opening the MCP host lands on the connection instructions.
    const host = mcpHost();
    if (host) rules.push({ source: "/", has: [{ type: "host", value: host }], destination: `${app}/settings/integrations`, permanent: false });
    // Pages and public/ files opened on a former address (APP_LEGACY_HOSTS) move to
    // APP_BASE_URL. API routes, webhooks, cron, the MCP endpoint, well-known documents and
    // /_next build assets keep answering on the old host, so integrations that still call it
    // do not break.
    for (const legacy of legacyHosts()) {
      rules.push({
        source: "/:path((?!api/|_next/|\\.well-known/|mcp(?:/|$)).*)",
        has: [{ type: "host", value: legacy }],
        destination: `${app}/:path`,
        permanent: false,
      });
    }
    return rules;
  },
  serverExternalPackages: ["postgres"],
  experimental: {
    // The admin Calendly import uploads a JSON snapshot through a server action.
    serverActions: { bodySizeLimit: "4mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Manage-token pages and their calendar files: never send the token in a Referer.
      {
        source: "/b/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
