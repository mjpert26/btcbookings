import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { runJobs } from "@/server/jobs/worker";
import { emailHandlers } from "@/server/email/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every 5 minutes (vercel.json). Reminders are delayed email_send jobs created at booking
 * time, and the main /api/cron/jobs worker sends them. This route is a safety net that
 * drains only email_send so reminders still go out if the main worker falls behind.
 */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const report = await runJobs(emailHandlers, { kinds: ["email_send"], deadlineMs: 45_000 });
  return NextResponse.json(report);
}
