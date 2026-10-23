import { describe, expect, it } from "vitest";
import { normalizeE164, redactPhone } from "@/server/sms/phone";
import { parseOptKeyword } from "@/server/sms/opt-out";
import { createSendblueClient } from "@/server/sms/sendblue";
import { agentReminderSms, merchantReminderSms } from "@/server/sms/templates";
import { agentReminderSlackText, slackEscape } from "@/server/slack/dm";
import { partnerDisplayName } from "@/server/email/partner";
import { leadTimeLabel, reminderSkipReason, type AgentReminderData } from "@/server/email/reminder-rules";
import { renderHostReminder, renderInviteeEmail } from "@/server/email/render";
import type { InviteeEmailData } from "@/server/email/templates/invitee";
import { buildUpdatePayload, type EventPayloadInput } from "@/server/graph/event-payload";
import { PermanentJobError, RetryAfterError } from "@/server/jobs/types";
import { checkSigningSecret } from "@/server/sms/inbound";

const START = new Date("2026-11-03T15:00:00Z");
const END = new Date("2026-11-03T15:30:00Z");

describe("normalizeE164", () => {
  it.each([
    ["(212) 555-0142", "+12125550142"],
    ["212.555.0142", "+12125550142"],
    ["1-212-555-0142", "+12125550142"],
    ["+1 212 555 0142", "+12125550142"],
    ["+44 20 7946 0958", "+442079460958"],
    ["0044 20 7946 0958", "+442079460958"],
    ["212-555-0142 x55", "+12125550142"],
  ])("normalizes %s", (input, out) => {
    expect(normalizeE164(input)).toBe(out);
  });

  it.each([null, "", "555-0142", "012-555-0142", "212-055-0142", "+0 212 555 0142", "call me", "+1 212 555 0142 +1", "1234567890123456"])(
    "rejects %s",
    (input) => {
      expect(normalizeE164(input)).toBeNull();
    },
  );

  it("redacts numbers for logs", () => {
    expect(redactPhone("+12125550142")).toBe("+1******0142");
  });
});

describe("parseOptKeyword", () => {
  it.each(["STOP", "stop", " Stop. ", "UNSUBSCRIBE", "stop all", "ALTO", "Cancel"])("treats %s as an opt-out", (s) => {
    expect(parseOptKeyword(s)?.action).toBe("stop");
  });
  it.each(["START", "unstop", "Start!"])("treats %s as a re-subscribe", (s) => {
    expect(parseOptKeyword(s)?.action).toBe("start");
  });
  it.each(["Please stop by at 3", "Thanks", "", null, "Can we start later?"])("ignores %s", (s) => {
    expect(parseOptKeyword(s)).toBeNull();
  });
});

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { calls, fetchImpl };
}

describe("SendBlue client", () => {
  it("posts to send-message with the key headers and E.164 number", async () => {
    const f = fakeFetch(202, { status: "QUEUED", message_handle: "mh_1", error_code: null });
    const client = createSendblueClient({ apiKey: "kid", apiSecret: "sec", fromNumber: "+13055550100", fetch: f.fetchImpl });
    const out = await client.sendMessage({ to: "+12125550142", content: "Hello" });
    expect(out).toEqual({ messageHandle: "mh_1", status: "QUEUED", skipped: false });
    expect(f.calls[0].url).toBe("https://api.sendblue.com/api/send-message");
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers["sb-api-key-id"]).toBe("kid");
    expect(headers["sb-api-secret-key"]).toBe("sec");
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ number: "+12125550142", content: "Hello", from_number: "+13055550100" });
  });

  it("omits from_number when no line is configured", async () => {
    const f = fakeFetch(200, { status: "QUEUED", message_handle: "mh_2" });
    await createSendblueClient({ apiKey: "k", apiSecret: "s", fetch: f.fetchImpl }).sendMessage({ to: "+12125550142", content: "x" });
    expect(JSON.parse(f.calls[0].init.body as string)).not.toHaveProperty("from_number");
  });

  it("retries later on HTTP 429 using Retry-After", async () => {
    const f = fakeFetch(429, { error: "rate" }, { "retry-after": "12" });
    const err = await createSendblueClient({ apiKey: "k", apiSecret: "s", fetch: f.fetchImpl })
      .sendMessage({ to: "+12125550142", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfterSeconds).toBe(12);
  });

  it("retries a line capacity decline in an hour", async () => {
    const f = fakeFetch(400, { error_code: 429, error_key: "LINE_DAILY_LIMIT_REACHED" });
    const err = await createSendblueClient({ apiKey: "k", apiSecret: "s", fetch: f.fetchImpl })
      .sendMessage({ to: "+12125550142", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfterSeconds).toBe(3600);
  });

  it("fails permanently on validation errors and ERROR statuses, never exposing the secret", async () => {
    for (const [status, body] of [
      [400, { error_code: 4000, error_message: "bad number" }],
      [200, { status: "ERROR", error_code: 4002 }],
      [200, { status: "DECLINED", error_key: "BLOCKED" }],
    ] as const) {
      const f = fakeFetch(status, body);
      const err = await createSendblueClient({ apiKey: "k", apiSecret: "very-secret", fetch: f.fetchImpl })
        .sendMessage({ to: "+12125550142", content: "x" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentJobError);
      expect(String((err as Error).message)).not.toContain("very-secret");
    }
  });

  it("treats 5xx as transient", async () => {
    const f = fakeFetch(503, {});
    const err = await createSendblueClient({ apiKey: "k", apiSecret: "s", fetch: f.fetchImpl })
      .sendMessage({ to: "+12125550142", content: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(err).not.toBeInstanceOf(RetryAfterError);
  });
});

describe("partnerDisplayName", () => {
  it("uses the configured display name, then the team name", () => {
    expect(partnerDisplayName({ name: "Acme ISO" })).toBe("Acme ISO");
    expect(partnerDisplayName({ name: "Acme ISO" }, "Acme Funding Partners")).toBe("Acme Funding Partners");
    expect(partnerDisplayName({ name: "Acme ISO" }, "  ")).toBe("Acme ISO");
    expect(partnerDisplayName(null)).toBeNull();
  });
});

describe("reminderSkipReason", () => {
  const b = (status: string) => ({ status, start_at: START });
  const due = START.getTime() - 15 * 60_000;
  it("sends when due", () => {
    expect(reminderSkipReason("merchant", b("confirmed"), 15, due)).toBeNull();
    expect(reminderSkipReason("agent", b("flagged"), 15, due)).toBeNull();
  });
  it("skips merchants on flagged bookings, cancelled bookings, started meetings and moved starts", () => {
    expect(reminderSkipReason("merchant", b("flagged"), 15, due)).toBe("status_flagged");
    expect(reminderSkipReason("agent", b("cancelled"), 15, due)).toBe("status_cancelled");
    expect(reminderSkipReason("agent", b("confirmed"), 15, START.getTime())).toBe("started");
    expect(reminderSkipReason("agent", b("confirmed"), 15, due - 60 * 60_000)).toBe("start_moved");
  });
  it("labels lead times", () => {
    expect(leadTimeLabel(5)).toBe("5 minutes");
    expect(leadTimeLabel(60)).toBe("1 hour");
    expect(leadTimeLabel(1440)).toBe("1 day");
  });
});

describe("SMS bodies", () => {
  const base = {
    eventName: "Funding consultation",
    partnerName: "Acme ISO",
    start: START,
    timezone: "America/New_York",
    joinUrl: "https://teams.example/join",
    manageUrl: "http://localhost:3000/b/tok",
  };
  it("renders the English merchant reminder with the partner and opt-out line", () => {
    const text = merchantReminderSms({ ...base, locale: "en" });
    expect(text).toContain("Reminder from Big Think Capital: Funding consultation on Tue, Nov 3 at 10:00 AM EST.");
    expect(text).toContain("Partner: Acme ISO.");
    expect(text).toContain("Join: https://teams.example/join");
    expect(text).toContain("Reschedule or cancel: http://localhost:3000/b/tok");
    expect(text.endsWith("Reply STOP to opt out.")).toBe(true);
  });
  it("renders the Spanish merchant reminder", () => {
    const text = merchantReminderSms({ ...base, locale: "es", partnerName: null });
    expect(text).toMatch(/^Recordatorio de Big Think Capital: Funding consultation el /);
    expect(text).not.toContain("Socio comercial");
    expect(text).toContain("Responda STOP");
  });
});

const agent: AgentReminderData = {
  hostName: "Dana Host",
  hostEmail: "dana@bigthinkcapital.com",
  timezone: "America/Los_Angeles",
  eventName: "Funding consultation",
  partnerName: "Acme <ISO>",
  start: START,
  end: END,
  inviteeName: "Pat Smith",
  inviteeEmail: "pat@example.com",
  inviteePhone: "(212) 555-0142",
  answers: [{ label: "Company", value: "Pat's Pizza & Co" }],
  meeting: { text: "Join Microsoft Teams meeting", url: "https://teams.example/join" },
  bookingUrl: "http://localhost:3000/bookings/abc",
  offsetMin: 15,
};

describe("agent reminder messages", () => {
  it("builds the Slack DM in the agent's time zone with escaped values", () => {
    const text = agentReminderSlackText(agent);
    expect(text).toContain("*Reminder: Funding consultation starts in 15 minutes*");
    expect(text).toContain("*Partner:* Acme &lt;ISO&gt;");
    expect(text).toContain("7:00 AM"); // 15:00 UTC in Los Angeles
    expect(text).toContain("*Merchant:* Pat Smith (pat@example.com)");
    expect(text).toContain("*Phone:* (212) 555-0142");
    expect(text).toContain("*Company:* Pat's Pizza &amp; Co");
    expect(text).toContain("<https://teams.example/join|Join Microsoft Teams meeting>");
    expect(text).toContain("<http://localhost:3000/bookings/abc|Open booking>");
    expect(slackEscape("<@U1>")).toBe("&lt;@U1&gt;");
  });

  it("builds the agent text message", () => {
    const text = agentReminderSms(agent);
    expect(text).toContain("Reminder: Funding consultation with Pat Smith (Acme <ISO>) on Tue, Nov 3 at 7:00 AM PST.");
    expect(text).toContain("Phone: (212) 555-0142.");
    expect(text).toContain("Join: https://teams.example/join");
  });

  it("renders the agent reminder email", async () => {
    const r = await renderHostReminder({ ...agent, logoUrl: "http://localhost:3000/brand/btc-logo.png" });
    expect(r.subject).toBe("Reminder: Funding consultation with Pat Smith (Acme <ISO>) at 7:00 AM");
    expect(r.html).toContain("Your meeting starts in 15 minutes");
    expect(r.text).toContain("Acme <ISO>");
    expect(r.text).toContain("Pat's Pizza & Co");
    expect(r.html).toContain("https://teams.example/join");
  });
});

function inviteeData(over: Partial<InviteeEmailData> = {}): InviteeEmailData {
  return {
    locale: "en",
    inviteeName: "Pat",
    eventName: "Consultation",
    start: START,
    end: END,
    timezone: "America/New_York",
    hostNames: ["Dana Host"],
    locationType: "teams",
    locationDetail: null,
    onlineMeetingUrl: null,
    manageUrl: "http://localhost:3000/b/tok",
    bookAgainUrl: null,
    logoUrl: "http://localhost:3000/brand/btc-logo.png",
    ...over,
  };
}

describe("partner name in merchant emails", () => {
  it("shows the partner on team pages in every invitee template", async () => {
    for (const kind of ["confirmed", "rescheduled", "cancelled", "reminder"] as const) {
      const en = await renderInviteeEmail(kind, inviteeData({ partnerName: "Acme ISO" }));
      expect(en.text).toMatch(/Partner\s+Acme ISO/);
    }
    const es = await renderInviteeEmail("reminder", inviteeData({ locale: "es", partnerName: "Acme ISO" }));
    expect(es.text).toMatch(/socio comercial/i);
  });

  it("leaves individual pages unchanged", async () => {
    const r = await renderInviteeEmail("confirmed", inviteeData());
    expect(r.text).not.toMatch(/partner/i);
  });
});

describe("partner name in the Outlook event", () => {
  const input: EventPayloadInput = {
    bookingId: "00000000-0000-4000-8000-000000000099",
    eventTypeName: "Consultation",
    startAt: START,
    endAt: END,
    invitee: { name: "Pat", email: "pat@example.com", phone: null, timezone: "America/New_York" },
    locationType: "teams",
    locationDetail: null,
    coHosts: [],
    answers: [],
  };
  it("adds the partner to the subject and body", () => {
    const p = buildUpdatePayload({ ...input, partnerName: "Acme ISO" });
    expect(p.subject).toBe("Consultation (Acme ISO): Pat");
    expect(p.body.content).toContain("<strong>Partner</strong></td><td>Acme ISO");
  });
  it("keeps the subject unchanged without a partner", () => {
    expect(buildUpdatePayload(input).subject).toBe("Consultation: Pat");
  });
});

describe("inbound webhook secret", () => {
  it("requires configuration and an exact match", () => {
    expect(checkSigningSecret("x", undefined)).toBe("not_configured");
    expect(checkSigningSecret(null, "secret-secret-secret")).toBe("unauthorized");
    expect(checkSigningSecret("secret-secret-secreT", "secret-secret-secret")).toBe("unauthorized");
    expect(checkSigningSecret("secret-secret-secret", "secret-secret-secret")).toBe("ok");
  });
});
