import { NextResponse } from "next/server";
import { destroySession } from "@/server/auth/session";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroySession();
  return NextResponse.redirect(`${env().APP_BASE_URL}/login?signedOut=1`, { status: 303 });
}
