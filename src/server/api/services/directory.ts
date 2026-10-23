import "server-only";
import { z } from "zod";
import { service } from "@/server/db/client";
import { changedFields, writeAudit } from "@/server/audit";
import { allowedEmailDomains } from "@/server/env";
import { isReservedSlug, slugify } from "@/server/auth/slug";
import { addManualMember, removeManualMember, SyncAdminError } from "@/server/sync/admin";
import { CAPABILITIES, can, ROLE_LABEL, ROLES, type Capability } from "@/lib/permissions";
import { ApiError, asCaller, forbidden, inCallerContext, invalid, mapDbError, notFound, requireCapability, type Caller } from "@/server/api/context";

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

export async function whoAmI(caller: Caller) {
  const teams = await asCaller(caller, (tx) => tx<{ id: string; name: string; slug: string; is_admin: boolean }[]>`
    select t.id, t.name, t.slug, exists (select 1 from app.team_admins ta where ta.team_id = t.id and ta.user_id = ${caller.user.id}) as is_admin
    from app.teams t
    where exists (select 1 from app.team_members tm where tm.team_id = t.id and tm.user_id = ${caller.user.id})
       or exists (select 1 from app.team_admins ta where ta.team_id = t.id and ta.user_id = ${caller.user.id})
    order by t.name
  `);
  return {
    id: caller.user.id,
    name: caller.user.name,
    email: caller.user.email,
    slug: caller.user.slug,
    timezone: caller.user.timezone,
    role: caller.user.role,
    roleLabel: ROLE_LABEL[caller.user.role],
    capabilities: (Object.keys(CAPABILITIES) as Capability[]).filter((c) => can(caller.user.role, c)),
    calendarConnected: caller.user.calendarStatus === "healthy",
    teams: teams.map((t) => ({ id: t.id, name: t.name, slug: t.slug, teamAdmin: t.is_admin })),
    via: caller.via,
  };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function mapSyncError(err: unknown): never {
  if (err instanceof SyncAdminError) {
    if (err.code === "forbidden") throw forbidden(err.message);
    if (err.code === "not_found") throw notFound("Team member");
    throw new ApiError(err.code === "conflict" ? 409 : 400, err.code, err.message);
  }
  mapDbError(err);
}

export async function listTeams(caller: Caller) {
  return asCaller(caller, (tx) => tx<{ id: string; name: string; slug: string; membershipSource: string; members: number; pages: number }[]>`
    select t.id, t.name, t.slug, t.membership_source::text as "membershipSource",
           (select count(*)::int from app.team_members tm where tm.team_id = t.id and tm.status = 'active') as members,
           (select count(*)::int from app.event_types et where et.team_id = t.id) as pages
    from app.teams t
    order by t.name
  `);
}

export async function getTeam(caller: Caller, id: string) {
  if (!uuid.safeParse(id).success) throw notFound("Team");
  return asCaller(caller, async (tx) => {
    const [team] = await tx<{ id: string; name: string; slug: string; description: string | null; membership_source: string; is_team_admin: boolean }[]>`
      select id, name, slug, description, membership_source::text, app.is_team_admin(id) as is_team_admin from app.teams where id = ${id}
    `;
    if (!team) throw notFound("Team");
    const members = await tx<{ id: string; userId: string | null; name: string | null; email: string; status: string; source: string }[]>`
      select tm.id, tm.user_id as "userId", u.name, tm.email::text as email, tm.status::text as status, tm.source::text as source
      from app.team_members tm left join app.users u on u.id = tm.user_id
      where tm.team_id = ${id}
      order by u.name nulls last, tm.email
    `;
    const admins = await tx<{ userId: string; name: string }[]>`
      select ta.user_id as "userId", u.name from app.team_admins ta join app.users u on u.id = ta.user_id where ta.team_id = ${id} order by u.name
    `;
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      description: team.description,
      membershipSource: team.membership_source,
      canManage: team.is_team_admin,
      members,
      admins,
    };
  });
}

/** Adds a rep to a team by email. Queue-driven teams follow the existing guard rules. */
export async function addTeamMember(caller: Caller, teamId: string, raw: unknown) {
  const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  try {
    const r = await inCallerContext(caller, () => addManualMember({ id: caller.user.id, role: caller.user.role }, teamId, parsed.data.email));
    return { teamMemberId: r.teamMemberId, status: r.status };
  } catch (err) {
    mapSyncError(err);
  }
}

export async function removeTeamMember(caller: Caller, teamId: string, teamMemberId: string) {
  if (!uuid.safeParse(teamMemberId).success) throw notFound("Team member");
  try {
    await inCallerContext(caller, () => removeManualMember({ id: caller.user.id, role: caller.user.role }, teamMemberId, { teamId }));
  } catch (err) {
    mapSyncError(err);
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  slug: string;
  role: string;
  roleLabel: string;
  isActive: boolean;
  signedIn: boolean;
  calendar: string | null;
  lastLoginAt: string | null;
};

export const listUsersSchema = z.object({
  search: z.string().max(100).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

/** The user directory. Everyone sees names and roles; calendar status only for the caller or admins. */
export async function listUsers(caller: Caller, raw: z.input<typeof listUsersSchema>): Promise<UserSummary[]> {
  const parsed = listUsersSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const q = parsed.data;
  const rows = await asCaller(caller, (tx) => tx<{ id: string; name: string; email: string; slug: string; role: keyof typeof ROLE_LABEL; is_active: boolean; signed_in: boolean; calendar: string | null; last_login_at: Date | null }[]>`
    select u.id, u.name, u.email::text as email, u.slug, u.role::text as role, u.is_active, u.entra_oid is not null as signed_in,
           cc.status::text as calendar, u.last_login_at
    from app.users u
    left join app.calendar_connections cc on cc.user_id = u.id
    where true
      ${q.search ? tx`and (u.name ilike ${"%" + q.search.replace(/[%_\\]/g, (m) => "\\" + m) + "%"} or u.email ilike ${"%" + q.search.replace(/[%_\\]/g, (m) => "\\" + m) + "%"})` : tx``}
      ${q.role ? tx`and u.role = ${q.role}` : tx``}
      ${q.active === undefined ? tx`` : tx`and u.is_active = ${q.active}`}
    order by u.name
    limit ${q.limit} offset ${q.offset}
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    slug: r.slug,
    role: r.role,
    roleLabel: ROLE_LABEL[r.role] ?? r.role,
    isActive: r.is_active,
    signedIn: r.signed_in,
    calendar: r.calendar,
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
  }));
}

export const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(1).max(200),
    role: z.enum(ROLES).default("user"),
    timezone: z.string().min(1).max(64).default("America/New_York"),
  })
  .strict();

/**
 * Pre-provisions a user (admins only). The account links to the person's Microsoft account the
 * first time they sign in with this email; until then they cannot host bookings.
 */
export async function createUser(caller: Caller, raw: unknown): Promise<UserSummary> {
  requireCapability(caller, "users.manage");
  const parsed = createUserSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const v = parsed.data;
  if (!allowedEmailDomains().includes(v.email.split("@")[1] ?? "")) {
    throw invalid(`Only company email addresses can be added (${allowedEmailDomains().join(", ")}).`);
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: v.timezone });
  } catch {
    throw invalid("Unknown timezone.");
  }
  const sql = service();
  const id = await sql.begin(async (tx) => {
    const [exists] = await tx`select 1 from app.users where email = ${v.email}`;
    if (exists) throw new ApiError(409, "conflict", "A user with this email already exists.");
    let slug = slugify(v.name || v.email.split("@")[0]);
    for (let i = 2; isReservedSlug(slug) || (await tx`select 1 from app.users where slug = ${slug}`).length; i++) slug = `${slugify(v.name).slice(0, 58)}-${i}`;
    const [row] = await tx<{ id: string }[]>`
      insert into app.users (email, name, slug, timezone, role) values (${v.email}, ${v.name}, ${slug}, ${v.timezone}, ${v.role}) returning id
    `;
    await tx`insert into app.availability_schedules (owner_user_id, name, timezone, is_default) values (${row.id}, 'Working hours', ${v.timezone}, true)`;
    await tx`insert into app.user_settings (user_id) values (${row.id}) on conflict do nothing`;
    await writeAudit(tx, {
      actorUserId: caller.user.id,
      action: "user.create",
      entityType: "user",
      entityId: row.id,
      after: { email: v.email, name: v.name, role: v.role },
      via: caller.via === "web" ? "web" : caller.via,
    });
    return row.id;
  });
  const [u] = await listUsers(caller, { search: v.email, limit: 1 });
  return u ?? { id, name: v.name, email: v.email, slug: "", role: v.role, roleLabel: ROLE_LABEL[v.role], isActive: true, signedIn: false, calendar: null, lastLoginAt: null };
}

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    role: z.enum(ROLES),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

/** Changes a user's name, role or active state (admins only). The last active admin cannot be demoted or deactivated. */
export async function updateUser(caller: Caller, id: string, raw: unknown): Promise<UserSummary> {
  requireCapability(caller, "users.manage");
  if (!uuid.safeParse(id).success) throw notFound("User");
  const parsed = updateUserSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const v = parsed.data;
  try {
    await asCaller(caller, async (tx) => {
      const admins = await tx<{ id: string }[]>`select id from app.users where role = 'admin' and is_active for update`;
      const [before] = await tx<{ id: string; email: string; name: string; role: string; is_active: boolean }[]>`
        select id, email::text as email, name, role::text as role, is_active from app.users where id = ${id}
      `;
      if (!before) throw notFound("User");
      const losesAdmin = before.role === "admin" && ((v.role && v.role !== "admin") || v.isActive === false);
      if (losesAdmin && admins.filter((a) => a.id !== id).length === 0) throw new ApiError(409, "last_admin", "At least one active admin must remain.");
      await tx`
        update app.users set name = ${v.name ?? before.name}, role = ${v.role ?? before.role}, is_active = ${v.isActive ?? before.is_active}
        where id = ${id}
      `;
      if (losesAdmin) await tx`delete from app.admin_seeds where email = ${before.email}`;
      const diff = changedFields({ name: before.name, role: before.role, isActive: before.is_active }, { name: v.name, role: v.role, isActive: v.isActive });
      if (diff) await writeAudit(tx, { actorUserId: caller.user.id, action: "user.update", entityType: "user", entityId: id, ...diff });
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    mapDbError(err);
  }
  // A deactivated user is signed out everywhere and their tokens stop working.
  if (v.isActive === false) {
    await service()`delete from app.sessions where user_id = ${id}`;
    await service()`update app.api_tokens set revoked_at = now() where user_id = ${id} and revoked_at is null`;
  }
  const [u] = await asCaller(caller, (tx) => tx<{ email: string }[]>`select email::text as email from app.users where id = ${id}`);
  const [row] = await listUsers(caller, { search: u.email, limit: 1 });
  return row;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const listAuditSchema = z.object({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  actorUserId: uuid.optional(),
  action: z.string().max(100).optional(),
  via: z.enum(["web", "api", "mcp", "sync", "system", "public"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export async function listAudit(caller: Caller, raw: z.input<typeof listAuditSchema>) {
  requireCapability(caller, "audit.read");
  const parsed = listAuditSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const q = parsed.data;
  const rows = await asCaller(caller, (tx) => tx<{ id: string; created_at: Date; action: string; entity_type: string; entity_id: string | null; actor: string | null; actor_user_id: string | null; via: string | null; before: unknown; after: unknown }[]>`
    select a.id, a.created_at, a.action, a.entity_type, a.entity_id, u.name as actor, a.actor_user_id, a.via, a.before, a.after
    from app.audit_log a left join app.users u on u.id = a.actor_user_id
    where true
      ${q.entityType ? tx`and a.entity_type = ${q.entityType}` : tx``}
      ${q.entityId ? tx`and a.entity_id = ${q.entityId}` : tx``}
      ${q.actorUserId ? tx`and a.actor_user_id = ${q.actorUserId}` : tx``}
      ${q.action ? tx`and a.action like ${q.action.replace(/[%_\\]/g, (m) => "\\" + m) + "%"}` : tx``}
      ${q.via ? tx`and a.via = ${q.via}` : tx``}
      ${q.from ? tx`and a.created_at >= ${q.from}` : tx``}
      ${q.to ? tx`and a.created_at < ${q.to}` : tx``}
    order by a.created_at desc
    limit ${q.limit} offset ${q.offset}
  `);
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at.toISOString(),
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    actor: r.actor,
    actorUserId: r.actor_user_id,
    via: r.via,
    before: r.before,
    after: r.after,
  }));
}
