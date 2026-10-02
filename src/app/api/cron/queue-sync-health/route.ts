import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { env } from "@/server/env";
import { checkQueueSyncHealth } from "@/server/sync/health";

export const dynamic = "force-dynamic";

/** Runs every 10 minutes (vercel.json). Flags teams whose queue poller has gone quiet. */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const report = await checkQueueSyncHealth(env().QUEUE_POLL_STALE_MINUTES);
  return NextResponse.json(report);
}
