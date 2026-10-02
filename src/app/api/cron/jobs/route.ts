import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { runJobs } from "@/server/jobs/worker";
import { jobHandlers } from "@/server/jobs/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Runs every minute (vercel.json). Drains the outbox until ~50 seconds have passed. */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const report = await runJobs(jobHandlers, { deadlineMs: 50_000 });
  return NextResponse.json(report);
}
