import { NextResponse } from "next/server";
import { service } from "@/server/db/client";
import { checkSyncHmac } from "@/server/sync/http";

export const dynamic = "force-dynamic";

/**
 * Queue ids the n8n poller should query: every queue linked to a team whose membership is
 * driven by Salesforce. HMAC-signed over an empty body.
 */
export async function GET(req: Request) {
  const auth = checkSyncHmac(req, "");
  if (!auth.ok) return auth.response;
  const rows = await service()<{ queue_id: string }[]>`
    select distinct q.queue_id
    from app.team_sf_queues q
    join app.teams t on t.id = q.team_id
    where t.membership_source <> 'manual'
    order by q.queue_id
  `;
  return NextResponse.json({ queueIds: rows.map((r) => r.queue_id) });
}
