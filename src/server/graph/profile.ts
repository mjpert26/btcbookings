import "server-only";
import { windowsToIana } from "@/server/graph/timezones";

/** Reads the signed-in user's mailbox time zone so new users start in their own zone. */
export async function fetchGraphProfile(accessToken: string): Promise<{ timezone?: string }> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return {};
  const json = (await res.json()) as { value?: string };
  return { timezone: json.value ? windowsToIana(json.value) : undefined };
}
