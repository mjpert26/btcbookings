import { NextResponse } from "next/server";
import { openApiDocument } from "@/server/api/openapi";

export const dynamic = "force-dynamic";

/** GET /api/v1/openapi.json: the API description (public; it contains no data). */
export function GET() {
  return NextResponse.json(openApiDocument(), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
