import "server-only";
import { z } from "zod";
import type { Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";

/**
 * Account link requests (app.account_link_requests). A sign-in whose display name matches
 * exactly one dormant imported Calendly account, and nothing else, is held until an admin
 * confirms that the imported account belongs to the person who signed in. See
 * completeLogin() in src/server/auth/login.ts.
 */

export type PendingLinkRequest = {
  id: string;
  user_id: string;
  imported_email: string;
  imported_name: string;
  imported_role: string;
  team_admin_of: number;
  email: string;
  name: string;
  attempts: number;
  requested_at: Date;
  last_requested_at: Date;
};

/**
 * Pending requests whose imported account is still unlinked, newest first. Run inside
 * withUser() for an admin; RLS returns nothing to anyone else.
 */
export async function listPendingLinkRequests(tx: Tx, limit = 100): Promise<PendingLinkRequest[]> {
  return tx<PendingLinkRequest[]>`
    select r.id, r.user_id, u.email::text as imported_email, u.name as imported_name, u.role::text as imported_role,
           (select count(*)::int from app.team_admins ta where ta.user_id = u.id) as team_admin_of,
           r.email::text as email, r.name, r.attempts, r.requested_at, r.last_requested_at
    from app.account_link_requests r
    join app.users u on u.id = r.user_id
    where r.status = 'pending' and u.entra_oid is null and u.last_login_at is null
    order by r.last_requested_at desc, r.id
    limit ${limit}
  `;
}

export const linkDecisionSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

export type LinkDecision = z.infer<typeof linkDecisionSchema>;
export type LinkDecisionResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Approves or rejects a pending request, with an audit entry in the same transaction. Run
 * inside withUser() for the acting admin.
 *
 * Approving links the imported account to the Microsoft account that signed in (object id
 * and email), so that person's next sign-in opens it, and closes other pending requests for
 * the same account. Rejecting means that person's next sign-in creates a new account.
 */
export async function decideLinkRequest(tx: Tx, actorUserId: string, input: LinkDecision): Promise<LinkDecisionResult> {
  const { requestId, decision } = linkDecisionSchema.parse(input);
  const [req] = await tx<{ id: string; user_id: string; entra_oid: string; email: string; name: string; status: string }[]>`
    select id, user_id, entra_oid, email::text as email, name, status
    from app.account_link_requests where id = ${requestId} for update
  `;
  if (!req) return { ok: false, error: "Request not found." };
  if (req.status !== "pending") return { ok: false, error: "This request has already been decided." };
  const [target] = await tx<{ email: string; name: string }[]>`
    select email::text as email, name from app.users where id = ${req.user_id} for update
  `;
  if (!target) return { ok: false, error: "The imported account no longer exists." };

  if (decision === "reject") {
    await tx`
      update app.account_link_requests set status = 'rejected', decided_at = now(), decided_by = ${actorUserId}
      where id = ${req.id}
    `;
    await writeAudit(tx, {
      actorUserId,
      action: "user.link_rejected",
      entityType: "user",
      entityId: req.user_id,
      after: { requestId: req.id, email: req.email },
    });
    return { ok: true, message: `${req.name} will get a new account at their next sign-in.` };
  }

  const [{ linked }] = await tx<{ linked: boolean }[]>`
    select app.link_imported_account(${req.user_id}, ${req.entra_oid}, ${req.email}::citext) as linked
  `;
  if (!linked) {
    return { ok: false, error: "The account could not be linked: it has signed in, is inactive, or the Microsoft account or email is already in use." };
  }
  await tx`
    update app.account_link_requests set status = 'approved', decided_at = now(), decided_by = ${actorUserId}
    where id = ${req.id}
  `;
  const closed = await tx`
    update app.account_link_requests set status = 'rejected', decided_at = now(), decided_by = ${actorUserId}
    where user_id = ${req.user_id} and status = 'pending' and id <> ${req.id}
    returning id
  `;
  await writeAudit(tx, {
    actorUserId,
    action: "user.link_approved",
    entityType: "user",
    entityId: req.user_id,
    before: { email: target.email },
    after: { email: req.email, entra_oid: req.entra_oid, requestId: req.id, otherRequestsClosed: closed.length },
  });
  return { ok: true, message: `${target.name} is linked to ${req.email}. They can sign in now.` };
}
