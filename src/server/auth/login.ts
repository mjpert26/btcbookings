import "server-only";
import { serviceTx, type Tx } from "@/server/db/client";
import { encryptSecret } from "@/server/crypto/aes";
import { adminEmails, allowedEmailDomains } from "@/server/env";
import { writeAudit } from "@/server/audit";
import { enqueue } from "@/server/jobs/queue";
import { enqueueMemberSlackJobs } from "@/server/slack/enqueue";
import { isReservedSlug, slugify } from "@/server/auth/slug";
import type { IdentityClaims, TokenSet } from "@/server/auth/entra";

export class LoginRejected extends Error {}

/**
 * The sign-in matched a dormant imported account by display name only. A link request was
 * recorded, and an admin must confirm it on Admin > Users before this person can sign in.
 */
export class LoginPendingLink extends LoginRejected {}

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

  const outcome = await serviceTx(async (tx): Promise<{ userId: string } | { pendingLink: true }> => {
    // Pre-provisioned accounts (for example from the Calendly import) are linked by email. The
    // user principal name is also tried, but only for rows not yet linked to any Microsoft
    // account, and a mail address match always wins. The row is locked so that two sign-ins
    // at the same moment cannot both link it.
    const upn = claims.preferredUsername.toLowerCase();
    const alias = upn.includes("@") && upn !== email ? upn : null;
    type Row = { id: string; email: string; role: "user" | "admin" | "manager"; entra_oid: string | null; is_active: boolean };
    const [existing] = await tx<Row[]>`
      select id, email::text as email, role, entra_oid, is_active from app.users
      where entra_oid = ${claims.oid} or email = ${email}::citext
         or (${alias}::citext is not null and email = ${alias}::citext and entra_oid is null)
      order by (entra_oid = ${claims.oid}) is true desc, (email = ${email}::citext) desc
      limit 1
      for update
    `;
    if (!existing && claims.name.trim()) {
      // Imported Calendly accounts may carry a derived email that differs from the real one.
      // A display name alone never links an account: two employees can share a name, and the
      // imported address may be the other person's real mailbox. When exactly one dormant,
      // active imported account has this name, the sign-in is held and an admin confirms the
      // link. After the admin rejects it, this Microsoft account gets a new account instead.
      const byName = await tx<{ id: string }[]>`
        select u.id from app.users u
        where u.entra_oid is null and u.import_source = 'calendly' and u.last_login_at is null and u.is_active
          and lower(btrim(u.name)) = lower(btrim(${claims.name}))
          and not exists (
            select 1 from app.account_link_requests r
            where r.user_id = u.id and r.entra_oid = ${claims.oid} and r.status = 'rejected'
          )
        limit 2
      `;
      if (byName.length === 1) {
        await recordLinkRequest(tx, byName[0].id, claims, email);
        return { pendingLink: true };
      }
    }
    if (existing && !existing.is_active) {
      throw new LoginRejected("This account has been deactivated. Contact an admin.");
    }
    if (existing?.entra_oid && existing.entra_oid !== claims.oid) {
      throw new LoginRejected("This email is linked to a different Microsoft account. Contact an admin.");
    }

    const [seed] = await tx`select 1 from app.admin_seeds where email = ${email}`;
    const shouldBeAdmin = Boolean(seed) || adminEmails().includes(email);

    let userId: string;
    if (existing) {
      userId = existing.id;
      const updated = await tx`
        update app.users
        set entra_oid = ${claims.oid}, email = ${email}, name = ${claims.name}, last_login_at = now(),
            role = case when ${shouldBeAdmin} then 'admin'::app.user_role else role end
        where id = ${userId} and (entra_oid is null or entra_oid = ${claims.oid})
        returning id
      `;
      if (!updated.length) {
        throw new LoginRejected("This account is linked to a different Microsoft account. Contact an admin.");
      }
      if (!existing.entra_oid) {
        await writeAudit(tx, {
          actorUserId: null,
          action: "user.linked",
          entityType: "user",
          entityId: userId,
          before: { email: existing.email },
          after: { email, entra_oid: claims.oid },
        });
      }
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
    // Create or renew the Outlook change-notification subscription after commit.
    await enqueue(tx, {
      kind: "graph_subscription_ensure",
      payload: { userId },
      idempotencyKey: `ensure:${userId}:login:${new Date().toISOString().slice(0, 10)}`,
    });
    return { userId };
  });
  // Thrown after the transaction so that the link request is committed.
  if ("pendingLink" in outcome) {
    throw new LoginPendingLink("An admin needs to confirm this account before it can sign in.");
  }
  return outcome.userId;
}

/**
 * Records, or refreshes, a pending link request for a sign-in that matched an imported
 * account by display name only. The first request for each pair is audited. A request that
 * was already decided is left unchanged.
 */
async function recordLinkRequest(tx: Tx, importedUserId: string, claims: IdentityClaims, email: string): Promise<void> {
  const name = claims.name.trim().slice(0, 300);
  const [row] = await tx<{ id: string; inserted: boolean }[]>`
    insert into app.account_link_requests (user_id, entra_oid, email, name)
    values (${importedUserId}, ${claims.oid}, ${email}, ${name})
    on conflict (user_id, entra_oid) do update set
      email = excluded.email,
      name = excluded.name,
      attempts = least(app.account_link_requests.attempts::bigint + 1, 2147483647)::int,
      last_requested_at = now()
    where app.account_link_requests.status = 'pending'
    returning id, (xmax = 0) as inserted
  `;
  if (row?.inserted) {
    await writeAudit(tx, {
      actorUserId: null,
      action: "user.link_requested",
      entityType: "user",
      entityId: importedUserId,
      after: { requestId: row.id, email },
    });
  }
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
    await enqueueMemberSlackJobs(tx, { teamId: m.team_id, teamMemberId: m.id, idempotencyKey: `activate:${m.id}:${Date.now()}` });
  }
}
