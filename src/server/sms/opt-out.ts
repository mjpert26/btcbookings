import "server-only";
import type { Db } from "@/server/db/client";

/**
 * SMS opt-out list (app.sms_opt_outs). Inbound replies with a stop keyword add the number;
 * a start keyword removes it. The SMS job checks the list before every send.
 */

/** Industry-standard stop keywords, plus Spanish equivalents. */
export const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "ALTO", "PARAR"] as const;
export const START_KEYWORDS = ["START", "UNSTOP", "SUBSCRIBE", "OPTIN"] as const;

export type OptKeyword = { action: "stop" | "start"; keyword: string };

/**
 * Reads a reply. Only a message that is exactly one keyword counts (case and surrounding
 * punctuation ignored), so ordinary replies that contain the word are not treated as opt-outs.
 */
export function parseOptKeyword(content: string | null | undefined): OptKeyword | null {
  if (!content) return null;
  const word = content
    .trim()
    .replace(/^[\s"'.,!¡¿?-]+|[\s"'.,!¡¿?-]+$/g, "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  if (!word || word.length > 20) return null;
  if ((STOP_KEYWORDS as readonly string[]).includes(word)) return { action: "stop", keyword: word };
  if ((START_KEYWORDS as readonly string[]).includes(word)) return { action: "start", keyword: word };
  return null;
}

export async function isOptedOut(db: Db, phoneE164: string): Promise<boolean> {
  const [row] = await db<{ phone_e164: string }[]>`select phone_e164 from app.sms_opt_outs where phone_e164 = ${phoneE164}`;
  return Boolean(row);
}

export async function recordOptOut(db: Db, phoneE164: string, keyword: string, source: "inbound" | "admin" = "inbound"): Promise<void> {
  await db`
    insert into app.sms_opt_outs (phone_e164, keyword, source, opted_out_at)
    values (${phoneE164}, ${keyword}, ${source}, now())
    on conflict (phone_e164) do update
      set keyword = excluded.keyword, source = excluded.source, opted_out_at = excluded.opted_out_at
  `;
}

/** Re-subscribes a number. Returns true when it was on the list. */
export async function clearOptOut(db: Db, phoneE164: string): Promise<boolean> {
  const rows = await db`delete from app.sms_opt_outs where phone_e164 = ${phoneE164} returning phone_e164`;
  return rows.length > 0;
}
