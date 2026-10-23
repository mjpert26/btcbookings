import type { Db } from "@/server/db/client";

/**
 * Partner (ISO) name shown in merchant and agent notifications for booking pages that
 * belong to a team.
 *
 * The team's branding display name (teams.page_settings.displayName) is used when set;
 * otherwise the team name applies.
 */
export function partnerDisplayName(team: { name: string } | null | undefined, displayName?: string | null): string | null {
  const configured = displayName?.trim();
  if (configured) return configured;
  const name = team?.name?.trim();
  return name ? name : null;
}

/** Partner name for an event type, or null for individual (non-team) pages. */
export async function partnerNameForEventType(db: Db, eventTypeId: string): Promise<string | null> {
  const [row] = await db<{ name: string; display_name: string | null }[]>`
    select t.name, t.page_settings->>'displayName' as display_name
    from app.event_types e join app.teams t on t.id = e.team_id where e.id = ${eventTypeId}
  `;
  return partnerDisplayName(row ?? null, row?.display_name);
}
