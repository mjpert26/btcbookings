import "server-only";
import { env } from "@/server/env";

/**
 * URLs of the OAuth 2.1 authorization server (this app) and the MCP resource server.
 *
 * The authorization server is always APP_BASE_URL, because the consent screen needs the
 * user's session cookie. The MCP endpoint is "<MCP_BASE_URL>/mcp" (for example
 * https://mcp.bigthinkcapital.com/mcp) and also answers at "<APP_BASE_URL>/mcp".
 */

export const MCP_SCOPE = "scheduler";
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const AUTH_CODE_TTL_SECONDS = 600;

export function issuer(): string {
  return env().APP_BASE_URL;
}

export function mcpOrigin(): string {
  return env().MCP_BASE_URL ?? env().APP_BASE_URL;
}

/** The canonical MCP resource identifier (RFC 8707), advertised to clients. */
export function mcpResource(): string {
  return `${mcpOrigin()}/mcp`;
}

/** Resource identifiers this deployment answers for. Tokens bound to any of them are accepted. */
export function acceptedResources(): string[] {
  const base = env().APP_BASE_URL;
  return [...new Set([mcpResource(), `${base}/mcp`, `${base}/api/mcp`])];
}

export function protectedResourceMetadataUrl(origin = mcpOrigin()): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    service_documentation: `${base}/settings/integrations`,
  };
}

export function protectedResourceMetadata(resource = mcpResource()) {
  return {
    resource,
    authorization_servers: [issuer()],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "BTC Scheduler",
    resource_documentation: `${issuer()}/settings/integrations`,
  };
}
