import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { runJobs } from "@/server/jobs/worker";
import { emailHandlers } from "@/server/email/jobs";
import { smsHandlers } from "@/server/sms/jobs";
import { slackDmHandlers } from "@/server/slack/dm-jobs";
import { REMINDER_JOB_KINDS } from "@/server/jobs/kinds";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every 5 minutes (vercel.json). Reminders are delayed email_send, sms_send and
 * slack_dm_send jobs created at booking time, and the main /api/cron/jobs worker sends
 * them. This route is a safety net that drains every job of those kinds (including the
 * non-reminder emails, such as confirmations and cancellations) so reminders still go out
 * if the main worker falls behind.
 */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const report = await runJobs(
    { ...emailHandlers, ...smsHandlers, ...slackDmHandlers },
    { kinds: [...REMINDER_JOB_KINDS], deadlineMs: 45_000 },
  );
  return NextResponse.json(report);
}
