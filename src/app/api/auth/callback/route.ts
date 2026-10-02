import { NextResponse } from "next/server";
import { service } from "@/server/db/client";
import { exchangeCode, verifyIdToken } from "@/server/auth/entra";
import { completeLogin, LoginRejected } from "@/server/auth/login";
import { createSession } from "@/server/auth/session";
import { sha256Hex } from "@/server/crypto/random";
import { decryptSecret } from "@/server/crypto/aes";
import { env } from "@/server/env";
import { fetchGraphProfile } from "@/server/graph/profile";

export const dynamic = "force-dynamic";

function fail(code: string) {
  return NextResponse.redirect(`${env().APP_BASE_URL}/login?error=${encodeURIComponent(code)}`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("error")) {
    // e.g. access_denied when the user cancels or consent is blocked by tenant policy.
    return fail(url.searchParams.get("error") === "access_denied" ? "access_denied" : "entra_error");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("invalid_request");

  const [row] = await service()<{ code_verifier_enc: string; nonce: string; return_to: string | null }[]>`
    delete from app.oauth_states where state = ${sha256Hex(state)} and expires_at > now()
    returning code_verifier_enc, nonce, return_to
  `;
  if (!row) return fail("state_expired");

  try {
    const tokens = await exchangeCode(code, decryptSecret(row.code_verifier_enc, "oauth_state"));
    if (!tokens.idToken) return fail("no_id_token");
    const claims = await verifyIdToken(tokens.idToken, row.nonce);
    const profile = await fetchGraphProfile(tokens.accessToken).catch(() => null);
    const userId = await completeLogin(claims, tokens, { timezone: profile?.timezone });
    await createSession(service(), userId);
    return NextResponse.redirect(`${env().APP_BASE_URL}${row.return_to ?? "/dashboard"}`);
  } catch (err) {
    if (err instanceof LoginRejected) return fail("not_allowed");
    console.error("sign-in failed", { message: (err as Error).message });
    return fail("signin_failed");
  }
}
