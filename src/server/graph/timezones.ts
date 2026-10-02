/**
 * Outlook often reports Windows time zone names. Maps the common US ones (and a few
 * others BTC is likely to see) to IANA. Unknown values that already look like IANA pass
 * through; anything else falls back to America/New_York.
 */
const MAP: Record<string, string> = {
  "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "SA Pacific Standard Time": "America/Bogota",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Venezuela Standard Time": "America/Caracas",
  "Argentina Standard Time": "America/Buenos_Aires",
  "E. South America Standard Time": "America/Sao_Paulo",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Israel Standard Time": "Asia/Jerusalem",
  "India Standard Time": "Asia/Kolkata",
  UTC: "UTC",
};

export function windowsToIana(name: string): string {
  if (MAP[name]) return MAP[name];
  if (/^[A-Za-z]+\/[A-Za-z_\-/]+$/.test(name)) return name;
  return "America/New_York";
}
