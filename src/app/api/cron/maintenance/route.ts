import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { service } from "@/server/db/client";
import { purgeRateLimits } from "@/server/http/rate-limit";

export const dynamic = "force-dynamic";

/** Daily cleanup of expired sessions, OAuth state, nonces, rate-limit windows, and old job attempts. */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const sql = service();
  await sql`delete from app.sessions where expires_at < now()`;
  await sql`delete from app.oauth_states where expires_at < now()`;
  await sql`delete from app.webhook_nonces where received_at < now() - interval '1 day'`;
  await purgeRateLimits(sql);
  await sql`delete from app.job_attempts where created_at < now() - interval '180 days'`;
  await sql`delete from app.jobs where status = 'succeeded' and updated_at < now() - interval '90 days'`;
  return NextResponse.json({ ok: true });
}
