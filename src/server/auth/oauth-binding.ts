import "server-only";

/**
 * Cookie that binds an in-flight sign-in to the browser that started it. The callback
 * only accepts a state whose stored binding hash matches this cookie, so a captured
 * callback URL cannot sign a different browser into the attacker's account.
 * SameSite=Lax is sent on the top-level redirect back from Microsoft.
 */
export function oauthBindingCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-btc_oauth" : "btc_oauth";
}

export const OAUTH_BINDING_MAX_AGE = 600;
