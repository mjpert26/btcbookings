import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { service, type Db } from "@/server/db/client";
import { randomToken, sha256Hex } from "@/server/crypto/random";
import { hashIp } from "@/server/http/ip";

export const SESSION_COOKIE = "__Host-btc_session";
const DEV_SESSION_COOKIE = "btc_session";
export const SESSION_TTL_DAYS = 14;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  slug: string;
  role: "user" | "admin";
  timezone: string;
  languages: string[];
  photoUrl: string | null;
  calendarStatus: "healthy" | "broken" | "disconnected" | null;
};

// __Host- cookies require Secure, which browsers reject on plain http://localhost.
function cookieName(): string {
  return process.env.NODE_ENV === "production" ? SESSION_COOKIE : DEV_SESSION_COOKIE;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken(32);
  const h = await headers();
  await db`
    insert into app.sessions (id, user_id, expires_at, user_agent, ip_hash)
    values (${sha256Hex(token)}, ${userId}, now() + make_interval(days => ${SESSION_TTL_DAYS}),
            ${(h.get("user-agent") ?? "").slice(0, 300)}, ${hashIp(h)})
  `;
  const jar = await cookies();
  jar.set(cookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86400,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(cookieName())?.value;
  if (token) await service()`delete from app.sessions where id = ${sha256Hex(token)}`;
  jar.delete(cookieName());
}

/** Returns the signed-in user, or null. Sessions slide: last_seen_at updates at most every 5 minutes. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(cookieName())?.value;
  if (!token || token.length > 100) return null;
  const sql = service();
  const rows = await sql<
    (Omit<SessionUser, "photoUrl" | "calendarStatus"> & {
      photo_url: string | null;
      calendar_status: SessionUser["calendarStatus"];
      last_seen_at: Date;
    })[]
  >`
    select u.id, u.email, u.name, u.slug, u.role, u.timezone, u.languages, u.photo_url,
           cc.status as calendar_status, s.last_seen_at
    from app.sessions s
    join app.users u on u.id = s.user_id and u.is_active
    left join app.calendar_connections cc on cc.user_id = u.id
    where s.id = ${sha256Hex(token)} and s.expires_at > now()
  `;
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await sql`update app.sessions set last_seen_at = now() where id = ${sha256Hex(token)}`;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    slug: row.slug,
    role: row.role,
    timezone: row.timezone,
    languages: row.languages,
    photoUrl: row.photo_url,
    calendarStatus: row.calendar_status,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/dashboard?error=forbidden");
  return user;
}
