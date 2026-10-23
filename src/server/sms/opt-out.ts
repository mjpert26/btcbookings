import "server-only";
import type { Db } from "@/server/db/client";

/**
 * SMS opt-out list (app.sms_opt_outs). Inbound replies with a stop keyword add the number;
 * a start keyword removes it. The SMS job checks the list before every send.
 */

/**
 * Stop keywords: the words the FCC revocation rule names (47 CFR 64.1200(a)(10): stop,
 * quit, end, revoke, opt out, cancel, unsubscribe), the industry-standard STOPALL, and
 * Spanish equivalents.
 */
export const STOP_KEYWORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
  "ALTO",
  "PARAR",
  "BAJA",
  "CANCELAR",
  "DETENER",
] as const;
export const START_KEYWORDS = ["START", "UNSTOP", "SUBSCRIBE", "OPTIN"] as const;

/** Keywords that mean an opt-out wherever they appear as a whole word, in any reply. */
const STRONG_STOP_KEYWORDS: readonly string[] = ["STOP", "STOPALL", "UNSUBSCRIBE", "REVOKE", "OPTOUT"];

/** A reply of at most this many words opts out when its first or last word is a stop keyword. */
export const SHORT_REPLY_MAX_WORDS = 6;

export type OptKeyword = { action: "stop" | "start"; keyword: string };

const isStop = (w: string | undefined): w is string => !!w && (STOP_KEYWORDS as readonly string[]).includes(w);

/**
 * Reads a reply (case, accents and punctuation ignored). Errs towards treating a reply as
 * an opt-out, as the revocation rule requires:
 *
 * - The whole reply is one keyword ("STOP", "Opt-out", "stop all", "START").
 * - STOP, STOPALL, UNSUBSCRIBE, REVOKE or OPT OUT appears as a whole word anywhere
 *   ("Please stop texting me").
 * - A short reply (up to SHORT_REPLY_MAX_WORDS words) starts or ends with any stop keyword
 *   ("cancel please", "dar de baja").
 *
 * Re-subscribing needs a reply that is exactly a start keyword, so "Can we start later?"
 * is ignored.
 */
export function parseOptKeyword(content: string | null | undefined): OptKeyword | null {
  if (!content) return null;
  const words = content
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    // "OPT OUT" and "OPT-OUT" count as the single word OPTOUT.
    .reduce<string[]>((acc, w) => {
      if (w === "OUT" && acc[acc.length - 1] === "OPT") acc[acc.length - 1] = "OPTOUT";
      else acc.push(w);
      return acc;
    }, []);
  if (!words.length) return null;

  const joined = words.join("");
  if (joined.length <= 20) {
    if (isStop(joined)) return { action: "stop", keyword: joined };
    if ((START_KEYWORDS as readonly string[]).includes(joined)) return { action: "start", keyword: joined };
  }
  const strong = words.find((w) => STRONG_STOP_KEYWORDS.includes(w));
  if (strong) return { action: "stop", keyword: strong };
  if (words.length <= SHORT_REPLY_MAX_WORDS) {
    const first = words[0];
    const last = words[words.length - 1];
    if (isStop(first)) return { action: "stop", keyword: first };
    if (isStop(last)) return { action: "stop", keyword: last };
  }
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
