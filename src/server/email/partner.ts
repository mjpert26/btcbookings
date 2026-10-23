import type { Db } from "@/server/db/client";

/**
 * Partner (ISO) name shown in merchant and agent notifications for booking pages that
 * belong to a team.
 *
 * Today the team name is used. A configurable display name can be passed as
 * `displayName`; when it is empty the team name applies.
 */
export function partnerDisplayName(team: { name: string } | null | undefined, displayName?: string | null): string | null {
  const configured = displayName?.trim();
  if (configured) return configured;
  const name = team?.name?.trim();
  return name ? name : null;
}

/** Partner name for an event type, or null for individual (non-team) pages. */
export async function partnerNameForEventType(db: Db, eventTypeId: string): Promise<string | null> {
  const [row] = await db<{ name: string }[]>`
    select t.name from app.event_types e join app.teams t on t.id = e.team_id where e.id = ${eventTypeId}
  `;
  return partnerDisplayName(row ?? null);
}
