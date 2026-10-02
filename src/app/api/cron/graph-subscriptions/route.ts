import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { ensureMissing, renewExpiring } from "@/server/graph/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Runs every 6 hours (vercel.json). Enqueues renewals for expiring and missing subscriptions. */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const renewing = await renewExpiring();
  const creating = await ensureMissing();
  return NextResponse.json({ renewing, creating });
}
