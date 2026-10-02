import "server-only";
import { service, serviceTx } from "@/server/db/client";
import { decryptSecret, encryptSecret } from "@/server/crypto/aes";
import { refreshTokens, TokenError, type TokenSet } from "@/server/auth/entra";

export class CalendarConnectionBroken extends Error {
  constructor(readonly userId: string, message: string) {
    super(message);
    this.name = "CalendarConnectionBroken";
  }
}

/** AADSTS codes meaning the account is disabled or no longer exists in the tenant. */
const ACCOUNT_GONE = ["AADSTS50057", "AADSTS50034", "AADSTS50053"];

type Refresher = (refreshToken: string) => Promise<TokenSet>;

/**
 * Returns a valid Graph access token for the user, refreshing if needed.
 *
 * Refresh runs under a row lock because Entra rotates refresh tokens; two concurrent
 * refreshes would otherwise race and one would store a token that is already spent.
 * A permanent refresh failure marks the connection broken: the user sees the
 * "Reconnect Outlook" banner and round-robin skips them until they reconnect.
 */
export async function getGraphAccessToken(userId: string, refresher: Refresher = (t) => refreshTokens(t)): Promise<string> {
  const [conn] = await service()<{ status: string; access_token_enc: string | null; token_expires_at: Date | null }[]>`
    select status, access_token_enc, token_expires_at from app.calendar_connections where user_id = ${userId}
  `;
  if (!conn) throw new CalendarConnectionBroken(userId, "No Outlook connection");
  if (conn.status !== "healthy") throw new CalendarConnectionBroken(userId, `Outlook connection is ${conn.status}`);
  if (conn.access_token_enc && conn.token_expires_at && conn.token_expires_at.getTime() > Date.now() + 120_000) {
    return decryptSecret(conn.access_token_enc, userId);
  }

  type Outcome = { token: string } | { broken: string };
  const outcome = await serviceTx<Outcome>(async (tx) => {
    const [locked] = await tx<
      { status: string; access_token_enc: string | null; refresh_token_enc: string | null; token_expires_at: Date | null }[]
    >`
      select status, access_token_enc, refresh_token_enc, token_expires_at
      from app.calendar_connections where user_id = ${userId} for update
    `;
    if (!locked || locked.status !== "healthy" || !locked.refresh_token_enc) {
      return { broken: "Outlook connection is not healthy" };
    }
    // Another request may have refreshed while we waited for the lock.
    if (locked.access_token_enc && locked.token_expires_at && locked.token_expires_at.getTime() > Date.now() + 120_000) {
      return { token: decryptSecret(locked.access_token_enc, userId) };
    }
    let fresh: TokenSet;
    try {
      fresh = await refresher(decryptSecret(locked.refresh_token_enc, userId));
    } catch (err) {
      if (err instanceof TokenError && err.permanent) {
        // Returning (not throwing) keeps the transaction committed with the broken status.
        await tx`
          update app.calendar_connections
          set status = 'broken', broken_at = now(), last_error = ${err.message.slice(0, 500)}
          where user_id = ${userId}
        `;
        // Disabled or deleted in Entra: end their app sessions too, so a departed employee
        // loses access within about an hour (the next background refresh), not 14 days.
        if (ACCOUNT_GONE.some((c) => err.message.includes(c))) {
          await tx`delete from app.sessions where user_id = ${userId}`;
        }
        return { broken: err.message };
      }
      throw err;
    }
    await tx`
      update app.calendar_connections set
        access_token_enc = ${encryptSecret(fresh.accessToken, userId)},
        refresh_token_enc = coalesce(${fresh.refreshToken ? encryptSecret(fresh.refreshToken, userId) : null}, refresh_token_enc),
        token_expires_at = ${fresh.expiresAt},
        scopes = ${fresh.scopes},
        last_error = null
      where user_id = ${userId}
    `;
    return { token: fresh.accessToken };
  });
  if ("broken" in outcome) throw new CalendarConnectionBroken(userId, outcome.broken);
  return outcome.token;
}
