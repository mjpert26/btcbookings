/**
 * Phone number normalization to E.164. Pure, so it is unit-tested directly.
 *
 * Accepted input:
 * - International numbers with a leading "+" (or "00"), 8 to 15 digits.
 * - North American numbers without a country code: 10 digits, or 11 digits starting with 1.
 *   BTC serves US merchants, so a bare national number is treated as NANP.
 *
 * Returns null for anything else, including NANP numbers whose area code or exchange
 * starts with 0 or 1, so the caller can skip the message.
 */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

export function normalizeE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 40) return null;
  // Drop an extension ("x123", "ext. 123") before reading digits.
  const main = trimmed.replace(/\s*(?:x|ext\.?|extension)\s*\d+$/i, "");
  if (/[^\d\s()+.-]/.test(main)) return null;
  if (main.indexOf("+") > 0 || (main.match(/\+/g)?.length ?? 0) > 1) return null;
  const international = main.startsWith("+") || main.startsWith("00");
  let digits = main.replace(/\D/g, "");
  if (international) {
    if (main.startsWith("00")) digits = digits.slice(2);
    const out = `+${digits}`;
    if (!E164_RE.test(out)) return null;
    if (out.startsWith("+1")) return validNanp(digits.slice(1)) ? out : null;
    return out;
  }
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10 || !validNanp(digits)) return null;
  return `+1${digits}`;
}

function validNanp(national: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national);
}

/** "+1******4567": enough to correlate logs without storing the number. */
export function redactPhone(phone: string): string {
  if (phone.length <= 6) return "***";
  return `${phone.slice(0, 2)}${"*".repeat(phone.length - 6)}${phone.slice(-4)}`;
}
