import "server-only";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto/random";

/** Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". Returns a 401 response when it does not match. */
export function assertCron(req: Request): NextResponse | null {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env().CRON_SECRET}`;
  if (!safeEqual(header, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
