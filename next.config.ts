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

// The MCP server answers at "<MCP_BASE_URL>/mcp" (for example https://mcp.bigthinkcapital.com/mcp)
// and also at "<APP_BASE_URL>/mcp".
function mcpHost(): string | null {
  try {
    return process.env.MCP_BASE_URL ? new URL(process.env.MCP_BASE_URL).host : null;
  } catch {
    return null;
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return { beforeFiles: [{ source: "/mcp", destination: "/api/mcp" }], afterFiles: [], fallback: [] };
  },
  async redirects() {
    const host = mcpHost();
    const app = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
    if (!host || !app) return [];
    // A browser opening the MCP host lands on the connection instructions.
    return [{ source: "/", has: [{ type: "host", value: host }], destination: `${app}/settings/integrations`, permanent: false }];
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
