import { createEvent, type EventAttributes } from "ics";

export type IcsInput = {
  /** Stable UID: the first booking in a reschedule chain, so updates replace the entry. */
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  organizerName?: string;
  cancelled?: boolean;
};

function toDateArray(d: Date): [number, number, number, number, number] {
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
}

/** Builds an iCalendar file (METHOD:PUBLISH) for the invitee. Times are UTC. */
export function buildIcs(input: IcsInput): string {
  const attrs: EventAttributes = {
    uid: input.uid,
    sequence: input.sequence,
    start: toDateArray(input.start),
    startInputType: "utc",
    startOutputType: "utc",
    end: toDateArray(input.end),
    endInputType: "utc",
    endOutputType: "utc",
    title: input.title,
    description: input.description,
    location: input.location,
    url: input.url,
    status: input.cancelled ? "CANCELLED" : "CONFIRMED",
    busyStatus: "BUSY",
    productId: "btc-scheduler",
    ...(input.organizerName ? { organizer: { name: input.organizerName } } : {}),
  };
  const { error, value } = createEvent(attrs);
  if (error || !value) throw error ?? new Error("Could not build calendar file");
  return value;
}

/** Google Calendar "add event" link. */
export function googleCalendarUrl(input: Pick<IcsInput, "title" | "start" | "end" | "description" | "location">): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${fmt(input.start)}/${fmt(input.end)}`,
  });
  if (input.description) p.set("details", input.description);
  if (input.location) p.set("location", input.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** Outlook.com "add event" link. */
export function outlookCalendarUrl(input: Pick<IcsInput, "title" | "start" | "end" | "description" | "location">): string {
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: input.title,
    startdt: input.start.toISOString(),
    enddt: input.end.toISOString(),
  });
  if (input.description) p.set("body", input.description);
  if (input.location) p.set("location", input.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${p.toString()}`;
}
