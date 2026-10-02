import { NextResponse } from "next/server";
import { assertCron } from "@/server/http/cron";
import { enqueueDeltaForHealthy } from "@/server/graph/delta";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Runs every 15 minutes (vercel.json). Enqueues a delta sync for every healthy connection. */
export async function GET(req: Request) {
  const denied = assertCron(req);
  if (denied) return denied;
  const enqueued = await enqueueDeltaForHealthy();
  return NextResponse.json({ enqueued });
}
