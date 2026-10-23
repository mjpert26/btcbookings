"use server";

import { getSessionUser } from "@/server/auth/session";
import { service } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { issuer } from "@/server/oauth/config";
import { createAuthCode, OAuthError, validateAuthorizeRequest } from "@/server/oauth/server";

export type ConsentResult = { redirectTo: string } | { error: string };

/**
 * Approves or denies an MCP client's authorization request. The browser then navigates to the
 * returned URL (a script navigation, so the CSP form-action rule does not block the client's
 * callback host).
 */
export async function decideAuthorization(query: string, decision: "allow" | "deny"): Promise<ConsentResult> {
  const user = await getSessionUser();
  if (!user) return { error: "Your session has expired. Sign in and try again." };
  let req;
  try {
    req = await validateAuthorizeRequest(new URLSearchParams(query));
  } catch (err) {
    return { error: err instanceof OAuthError ? err.description : "The authorization request is invalid." };
  }
  const url = new URL(req.redirectUri);
  if (decision === "deny") {
    url.searchParams.set("error", "access_denied");
  } else {
    const code = await createAuthCode(req, user.id);
    url.searchParams.set("code", code);
    await writeAudit(service(), {
      actorUserId: user.id,
      action: "oauth.authorize",
      entityType: "oauth_client",
      entityId: req.client.client_id,
      after: { client: req.client.name, redirectHost: url.host },
      via: "web",
    });
  }
  if (req.state) url.searchParams.set("state", req.state);
  url.searchParams.set("iss", issuer());
  return { redirectTo: url.toString() };
}
