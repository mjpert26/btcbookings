import { DateTime } from "luxon";

/**
 * Presentation helpers for audit entries: a field-level diff of the stored before/after
 * snapshots and readable labels for actions, actors and channels. Pure functions, shared by
 * the admin audit viewer, the booking history timeline and the REST/MCP booking detail.
 */

/** One changed field. `path` holds the keys from the top of the snapshot; `field` joins them with dots. */
export type FieldChange = { field: string; path: string[]; before: unknown; after: unknown };

const MAX_DEPTH = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function flatten(value: unknown, path: string[], out: Map<string, { path: string[]; value: unknown }>, depth: number): void {
  if (isPlainObject(value) && depth < MAX_DEPTH && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) flatten(v, [...path, k], out, depth + 1);
    return;
  }
  const p = path.length ? path : ["value"];
  out.set(JSON.stringify(p), { path: p, value });
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The fields that differ between an entry's before and after snapshots, as dot paths for
 * nested objects. A create (no before) lists every after field; a delete (no after) lists
 * every before field. Arrays are compared and shown whole.
 */
export function fieldChanges(before: unknown, after: unknown): FieldChange[] {
  const b = new Map<string, { path: string[]; value: unknown }>();
  const a = new Map<string, { path: string[]; value: unknown }>();
  if (before !== null && before !== undefined) flatten(before, [], b, 0);
  if (after !== null && after !== undefined) flatten(after, [], a, 0);
  const keys = [...new Set([...b.keys(), ...a.keys()])];
  const changes: FieldChange[] = [];
  for (const key of keys) {
    const bv = b.get(key);
    const av = a.get(key);
    if (b.size && a.size && same(bv?.value, av?.value)) continue;
    const path = (av ?? bv)!.path;
    changes.push({ field: path.join("."), path, before: bv?.value, after: av?.value });
  }
  return changes;
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A value as short readable text. Timestamps are shown in `zone`. */
export function formatAuditValue(value: unknown, zone = "UTC"): string {
  if (value === undefined) return "—";
  if (value === null || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (ISO_TS.test(value)) {
      const dt = DateTime.fromISO(value, { zone });
      if (dt.isValid) return dt.toFormat("d LLL yyyy, h:mm a ZZZZ");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.length) return "(none)";
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      return value.map((v) => formatAuditValue(v, zone)).join(", ");
    }
  }
  return JSON.stringify(value);
}

const SPECIAL_WORDS: Record<string, string> = { id: "ID", ids: "IDs", sf: "Salesforce", rr: "round-robin", url: "URL", uris: "URIs", sms: "SMS", iso: "ISO" };
const UNIT_SUFFIX: Record<string, string> = { min: "(min)", pct: "(%)" };

/**
 * "agent_reminder_offsets_min" or "dailyBookingCap" as "Agent reminder offsets (min)" / "Daily
 * booking cap". Nested paths are joined with "›"; keys that are not identifiers (emails, ids)
 * are shown as stored.
 */
export function fieldLabel(field: string | string[]): string {
  return (Array.isArray(field) ? field : field.split("."))
    .map((part) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(part)) return part;
      const words = part
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
      const last = words.length > 1 ? UNIT_SUFFIX[words[words.length - 1]] : undefined;
      if (last) words[words.length - 1] = last;
      const text = words.map((w) => SPECIAL_WORDS[w] ?? w).join(" ");
      return text.charAt(0).toUpperCase() + text.slice(1);
    })
    .join(" › ");
}

const BOOKING_ACTIONS: Record<string, string> = {
  "booking.create": "Booked",
  "booking.reschedule": "Rescheduled",
  "booking.cancel": "Cancelled",
  "booking.reassign": "Host reassigned",
  "booking.flag": "Flagged for review",
};

/** A readable label for an action; unknown actions are shown as stored. */
export function actionLabel(action: string): string {
  return BOOKING_ACTIONS[action] ?? action;
}

export const VIA_LABEL: Record<string, string> = {
  web: "Web app",
  api: "REST API",
  mcp: "MCP",
  sync: "Queue sync",
  system: "System",
  public: "Public booking page",
};

export function viaLabel(via: string | null): string {
  return via ? (VIA_LABEL[via] ?? via) : "Unknown";
}

/** Who made a change: the user's name, "Invitee" for public booking pages, otherwise "System". */
export function actorLabel(actorName: string | null, via: string | null): string {
  if (actorName) return actorName;
  return via === "public" ? "Invitee" : "System";
}
