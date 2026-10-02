import { NextResponse } from "next/server";
import { getBookingRowByToken } from "@/server/booking/manage";
import { buildIcs } from "@/server/booking/ics";
import { buildInviteeData } from "@/server/email/jobs";
import { locationText } from "@/server/email/templates/invitee";
import { service } from "@/server/db/client";
import { NO_STORE } from "@/server/booking/http";
import { chainRoot } from "@/server/booking/view";

export const dynamic = "force-dynamic";

/** GET /b/[token]/ics: the invitee's calendar file for a confirmed booking. */
export async function GET(_req: Request, ctx: RouteContext<"/b/[token]/ics">) {
  const { token } = await ctx.params;
  const booking = await getBookingRowByToken(token);
  if (!booking || (booking.status !== "confirmed" && booking.status !== "flagged")) {
    return new NextResponse("Not found", { status: 404, headers: NO_STORE });
  }
  const [data, chain] = await Promise.all([buildInviteeData(service(), booking), chainRoot(service(), booking.id)]);
  const loc = locationText(data);
  const ics = buildIcs({
    uid: `${chain.rootId}@btc-scheduler`,
    sequence: chain.depth,
    start: booking.start_at,
    end: booking.end_at,
    title: data.eventName,
    description: data.hostNames.join(", "),
    location: loc.url ?? loc.text,
    organizerName: data.hostNames[0],
  });
  return new NextResponse(ics, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="meeting.ics"',
    },
  });
}

