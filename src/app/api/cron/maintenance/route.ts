import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { service } from "@/server/db/client";
import { purgeRateLimits } from "@/server/http/rate-limit";
import { purgeErrorLog } from "@/server/errors/admin";

export const dynamic = "force-dynamic";

/** Daily cleanup of expired sessions, OAuth state and tokens, nonces, rate-limit windows, old job attempts, old error log entries and the 30-day API request log. */
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
  await purgeErrorLog(sql);
  await sql`delete from app.api_request_log where created_at < now() - interval '30 days'`;
  await sql`delete from app.oauth_codes where expires_at < now() - interval '1 day'`;
  await sql`delete from app.api_tokens where kind in ('oauth_access', 'oauth_refresh') and expires_at < now() - interval '1 day'`;
  return NextResponse.json({ ok: true });
}
