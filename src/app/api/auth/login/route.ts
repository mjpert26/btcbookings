import { NextResponse } from "next/server";
import { service } from "@/server/db/client";
import { buildAuthorizeUrl, pkcePair } from "@/server/auth/entra";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import { encryptSecret } from "@/server/crypto/aes";
import { safeReturnTo } from "@/server/http/redirects";
import { OAUTH_BINDING_MAX_AGE, oauthBindingCookieName } from "@/server/auth/oauth-binding";
import { EnvConfigError } from "@/server/env";

export const dynamic = "force-dynamic";

/** Starts the Entra sign-in. ?reconnect=1 is used by the "Reconnect Outlook" banner. */
export async function GET(req: Request) {
  try {
    return await startSignIn(req);
  } catch (err) {
    // Configuration or database problems should show a clear message, not a bare 500.
    if (err instanceof EnvConfigError) {
      console.error("sign-in unavailable: configuration", { missing: err.variables });
    } else {
      console.error("sign-in unavailable", { name: (err as Error).name, message: (err as Error).message?.slice(0, 200) });
    }
    return NextResponse.redirect(new URL("/login?error=server_config", req.url), 303);
  }
}

async function startSignIn(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const purpose = url.searchParams.get("reconnect") === "1" ? "reconnect" : "login";
  const state = randomToken(24);
  const nonce = randomToken(24);
  const binding = randomToken(24);
  const { verifier, challenge } = pkcePair();
  await service()`
    insert into app.oauth_states (state, code_verifier_enc, nonce, return_to, purpose, expires_at, browser_binding)
    values (${sha256Hex(state)}, ${encryptSecret(verifier, "oauth_state")}, ${nonce}, ${returnTo}, ${purpose},
            now() + interval '10 minutes', ${sha256Hex(binding)})
  `;
  // Opportunistic cleanup of abandoned sign-ins.
  await service()`delete from app.oauth_states where expires_at < now() - interval '1 hour'`;
  const res = NextResponse.redirect(
    buildAuthorizeUrl({ state, nonce, codeChallenge: challenge, prompt: purpose === "reconnect" ? "consent" : "select_account" }),
  );
  res.cookies.set(oauthBindingCookieName(), binding, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_BINDING_MAX_AGE,
  });
  return res;
}
