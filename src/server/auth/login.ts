import "server-only";
import { serviceTx, type Tx } from "@/server/db/client";
import { encryptSecret } from "@/server/crypto/aes";
import { adminEmails, allowedEmailDomains } from "@/server/env";
import { writeAudit } from "@/server/audit";
import { isReservedSlug, slugify } from "@/server/auth/slug";
import type { IdentityClaims, TokenSet } from "@/server/auth/entra";

export class LoginRejected extends Error {}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  let candidate = isReservedSlug(base) ? `${base}-btc` : base;
  for (let i = 2; i < 200; i++) {
    const [taken] = await tx`select 1 from app.users where slug = ${candidate}`;
    if (!taken) return candidate;
    candidate = `${base.slice(0, 56)}-${i}`;
  }
  throw new Error("Could not allocate a unique slug");
}

/**
 * Called after a successful Entra sign-in. Creates or updates the user, stores encrypted
 * Graph tokens, applies admin seeding, and activates any pending team memberships.
 * Returns the user id.
 */
export async function completeLogin(claims: IdentityClaims, tokens: TokenSet, profile?: { timezone?: string }): Promise<string> {
  const email = claims.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!allowedEmailDomains().includes(domain)) {
    throw new LoginRejected("This account is not a Big Think Capital account.");
  }
  if (!tokens.refreshToken) {
    throw new LoginRejected("Microsoft did not return a refresh token. Make sure offline_access is granted.");
  }

  return serviceTx(async (tx) => {
    const [existing] = await tx<{ id: string; role: "user" | "admin"; entra_oid: string | null }[]>`
      select id, role, entra_oid from app.users
      where entra_oid = ${claims.oid} or email = ${email}
      order by (entra_oid = ${claims.oid}) desc nulls last
      limit 1
    `;
    if (existing?.entra_oid && existing.entra_oid !== claims.oid) {
      throw new LoginRejected("This email is linked to a different Microsoft account. Contact an admin.");
    }

    const [seed] = await tx`select 1 from app.admin_seeds where email = ${email}`;
    const shouldBeAdmin = Boolean(seed) || adminEmails().includes(email);

    let userId: string;
    if (existing) {
      userId = existing.id;
      await tx`
        update app.users
        set entra_oid = ${claims.oid}, email = ${email}, name = ${claims.name}, last_login_at = now(),
            role = case when ${shouldBeAdmin} then 'admin'::app.user_role else role end
        where id = ${userId}
      `;
      if (shouldBeAdmin && existing.role !== "admin") {
        await writeAudit(tx, {
          actorUserId: null,
          action: "role.promote_seeded_admin",
          entityType: "user",
          entityId: userId,
          before: { role: existing.role },
          after: { role: "admin" },
        });
      }
    } else {
      const slug = await uniqueSlug(tx, slugify(claims.name || email.split("@")[0]));
      const [row] = await tx<{ id: string }[]>`
        insert into app.users (entra_oid, email, name, slug, timezone, role, last_login_at)
        values (${claims.oid}, ${email}, ${claims.name}, ${slug}, ${profile?.timezone ?? "America/New_York"},
                ${shouldBeAdmin ? "admin" : "user"}, now())
        returning id
      `;
      userId = row.id;
      await tx`
        insert into app.availability_schedules (owner_user_id, name, timezone, is_default)
        values (${userId}, 'Working hours', ${profile?.timezone ?? "America/New_York"}, true)
      `;
      await tx`insert into app.user_settings (user_id) values (${userId}) on conflict do nothing`;
      await writeAudit(tx, {
        actorUserId: null,
        action: "user.created",
        entityType: "user",
        entityId: userId,
        after: { email, role: shouldBeAdmin ? "admin" : "user" },
      });
    }

    await tx`
      insert into app.calendar_connections
        (user_id, status, access_token_enc, refresh_token_enc, token_expires_at, scopes, last_error, broken_at)
      values (${userId}, 'healthy', ${encryptSecret(tokens.accessToken, userId)},
              ${encryptSecret(tokens.refreshToken!, userId)}, ${tokens.expiresAt}, ${tokens.scopes}, null, null)
      on conflict (user_id) do update set
        status = 'healthy',
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        token_expires_at = excluded.token_expires_at,
        scopes = excluded.scopes,
        last_error = null,
        broken_at = null
    `;

    await activatePendingMemberships(tx, userId, email);
    return userId;
  });
}

/**
 * Links queue-sourced members who had never signed in, and returns pending members to
 * active now that the calendar connection is healthy.
 */
export async function activatePendingMemberships(tx: Tx, userId: string, email: string): Promise<void> {
  await tx`update app.team_members set user_id = ${userId} where email = ${email} and user_id is null`;
  const activated = await tx<{ id: string; team_id: string }[]>`
    update app.team_members set status = 'active', paused_reason = null
    where user_id = ${userId} and status = 'pending_onboarding'
    returning id, team_id
  `;
  for (const m of activated) {
    await tx`
      insert into app.membership_events (team_id, team_member_id, email, old_status, new_status, source, detail)
      values (${m.team_id}, ${m.id}, ${email}, 'pending_onboarding', 'active', 'system',
              ${tx.json({ reason: "signed_in_and_connected_outlook" })})
    `;
    await tx`
      insert into app.jobs (kind, payload, team_id, idempotency_key)
      values ('slack_membership_sync', ${tx.json({ teamId: m.team_id, teamMemberId: m.id })}, ${m.team_id},
              ${"activate:" + m.id + ":" + Date.now()})
    `;
  }
}
