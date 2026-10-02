import { NextResponse } from "next/server";
import { service } from "@/server/db/client";
import { buildAuthorizeUrl, pkcePair } from "@/server/auth/entra";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import { encryptSecret } from "@/server/crypto/aes";
import { safeReturnTo } from "@/server/http/redirects";

export const dynamic = "force-dynamic";

/** Starts the Entra sign-in. ?reconnect=1 is used by the "Reconnect Outlook" banner. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const purpose = url.searchParams.get("reconnect") === "1" ? "reconnect" : "login";
  const state = randomToken(24);
  const nonce = randomToken(24);
  const { verifier, challenge } = pkcePair();
  await service()`
    insert into app.oauth_states (state, code_verifier_enc, nonce, return_to, purpose, expires_at)
    values (${sha256Hex(state)}, ${encryptSecret(verifier, "oauth_state")}, ${nonce}, ${returnTo}, ${purpose},
            now() + interval '10 minutes')
  `;
  // Opportunistic cleanup of abandoned sign-ins.
  await service()`delete from app.oauth_states where expires_at < now() - interval '1 hour'`;
  return NextResponse.redirect(
    buildAuthorizeUrl({ state, nonce, codeChallenge: challenge, prompt: purpose === "reconnect" ? "consent" : "select_account" }),
  );
}
