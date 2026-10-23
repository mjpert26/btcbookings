import "server-only";
import { z } from "zod";
import { service, withUser, type Db, type Tx } from "@/server/db/client";
import { changedFields, writeAudit } from "@/server/audit";
import { sha256Hex } from "@/server/crypto/random";
import { tokenSchema } from "@/server/booking/validation";
import { validateLogo, type LogoContentType } from "@/server/teams/logo";
import {
  accessibleAccent,
  parsePageSettings,
  resolvePageSettings,
  toStoredPageSettings,
  type PageSettings,
} from "@/server/teams/page-settings";

/**
 * Partner (team) branding: reading the settings for public pages and notifications, and the
 * audited writes behind /teams/[id]/branding. Writes run inside withUser so RLS applies; they
 * additionally require app.is_team_admin(team_id), which is true for global admins.
 */

export type BrandingActor = { id: string };

export type TeamBrandingErrorCode = "forbidden" | "not_found" | "invalid";

export class TeamBrandingError extends Error {
  constructor(readonly code: TeamBrandingErrorCode, message: string) {
    super(message);
    this.name = "TeamBrandingError";
  }
}

/** Public-safe branding for a partner. Contains no ids other than the team id in the logo URL. */
export type PartnerBranding = {
  teamId: string;
  teamName: string;
  /** The partner name to show: the display name when set, otherwise the team name. */
  displayName: string;
  /** Path of the uploaded logo with a content-hash version, or null when there is none. */
  logoUrl: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  /** Accent for public pages, already checked for contrast (falls back to the brand color). */
  accentColor: string;
  accentHover: string;
  heading: string | null;
  intro: string | null;
  showHostPhoto: boolean;
  showHostName: boolean;
  showBtcLogo: boolean;
  showDuration: boolean;
  showDescription: boolean;
  showPartnerLogo: boolean;
};

export const LOGO_ROUTE = "/api/public/team-logo";

export function teamLogoPath(teamId: string, sha256: string): string {
  return `${LOGO_ROUTE}/${teamId}?v=${sha256.slice(0, 16)}`;
}

type BrandingRow = {
  id: string;
  name: string;
  page_settings: unknown;
  logo_sha256: string | null;
  logo_width: number | null;
  logo_height: number | null;
};

export function buildPartnerBranding(row: BrandingRow): PartnerBranding {
  const s = resolvePageSettings(row.page_settings);
  const accent = accessibleAccent(s.accentColor);
  return {
    teamId: row.id,
    teamName: row.name,
    displayName: s.displayName ?? row.name,
    logoUrl: row.logo_sha256 ? teamLogoPath(row.id, row.logo_sha256) : null,
    logoWidth: row.logo_width,
    logoHeight: row.logo_height,
    accentColor: accent.color,
    accentHover: accent.hover,
    heading: s.heading,
    intro: s.intro,
    showHostPhoto: s.showHostPhoto,
    showHostName: s.showHostName,
    showBtcLogo: s.showBtcLogo,
    showDuration: s.showDuration,
    showDescription: s.showDescription,
    showPartnerLogo: s.showPartnerLogo,
  };
}

/**
 * Branding for a team, for public pages and notifications. Uses the service connection and
 * reads only display columns. Returns null for an unknown team.
 */
export async function getPartnerBranding(teamId: string, db: Db = service()): Promise<PartnerBranding | null> {
  if (!z.string().uuid().safeParse(teamId).success) return null;
  const [row] = await db<BrandingRow[]>`
    select t.id, t.name, t.page_settings, l.sha256 as logo_sha256, l.width as logo_width, l.height as logo_height
    from app.teams t left join app.team_logos l on l.team_id = t.id
    where t.id = ${teamId}
  `;
  return row ? buildPartnerBranding(row) : null;
}

/** Branding for the team that owns an event type, or null for individual event types. */
export async function getPartnerBrandingForEventType(eventTypeId: string, db: Db = service()): Promise<PartnerBranding | null> {
  const [row] = await db<{ team_id: string | null }[]>`select team_id from app.event_types where id = ${eventTypeId}`;
  return row?.team_id ? getPartnerBranding(row.team_id, db) : null;
}

/** Branding for the booking a manage token belongs to, or null for individual bookings. */
export async function getPartnerBrandingForManageToken(token: string, db: Db = service()): Promise<PartnerBranding | null> {
  if (!tokenSchema.safeParse(token).success) return null;
  const [row] = await db<{ team_id: string | null }[]>`
    select e.team_id from app.bookings b join app.event_types e on e.id = b.event_type_id
    where b.manage_token_hash = ${sha256Hex(token)}
  `;
  return row?.team_id ? getPartnerBranding(row.team_id, db) : null;
}

/** The stored logo for the public logo route. */
export async function loadTeamLogo(
  teamId: string,
  db: Db = service(),
): Promise<{ contentType: LogoContentType; bytes: Buffer; sha256: string; updatedAt: Date } | null> {
  if (!z.string().uuid().safeParse(teamId).success) return null;
  const [row] = await db<{ content_type: LogoContentType; bytes: Buffer; sha256: string; updated_at: Date }[]>`
    select content_type, bytes, sha256, updated_at from app.team_logos where team_id = ${teamId}
  `;
  return row ? { contentType: row.content_type, bytes: row.bytes, sha256: row.sha256, updatedAt: row.updated_at } : null;
}

// ---------------------------------------------------------------------------
// Admin and team admin writes
// ---------------------------------------------------------------------------

async function requireTeamAdmin(tx: Tx, teamId: string): Promise<{ name: string; page_settings: unknown }> {
  if (!z.string().uuid().safeParse(teamId).success) throw new TeamBrandingError("not_found", "team not found");
  const [team] = await tx<{ name: string; page_settings: unknown; ok: boolean }[]>`
    select name, page_settings, app.is_team_admin(id) as ok from app.teams where id = ${teamId}
  `;
  if (!team) throw new TeamBrandingError("not_found", "team not found");
  if (!team.ok) throw new TeamBrandingError("forbidden", "team admin role required");
  return team;
}

/** Settings and logo metadata for the branding form. */
export async function getTeamBrandingForEdit(
  actor: BrandingActor,
  teamId: string,
): Promise<{
  team: { id: string; name: string; slug: string };
  settings: PageSettings;
  logo: { contentType: string; byteSize: number; width: number | null; height: number | null; url: string; updatedAt: Date } | null;
}> {
  return withUser(actor.id, async (tx) => {
    await requireTeamAdmin(tx, teamId);
    const [team] = await tx<{ id: string; name: string; slug: string; page_settings: unknown }[]>`
      select id, name, slug, page_settings from app.teams where id = ${teamId}
    `;
    const [logo] = await tx<{ content_type: string; byte_size: number; width: number | null; height: number | null; sha256: string; updated_at: Date }[]>`
      select content_type, byte_size, width, height, sha256, updated_at from app.team_logos where team_id = ${teamId}
    `;
    return {
      team: { id: team.id, name: team.name, slug: team.slug },
      settings: resolvePageSettings(team.page_settings),
      logo: logo
        ? {
            contentType: logo.content_type,
            byteSize: logo.byte_size,
            width: logo.width,
            height: logo.height,
            url: teamLogoPath(teamId, logo.sha256),
            updatedAt: logo.updated_at,
          }
        : null,
    };
  });
}

/**
 * Replaces a team's page settings. `input` is validated strictly (unknown keys are rejected).
 * Fields left out of `input` are reset to their defaults. The audit entry records only the
 * fields that changed.
 */
export async function savePageSettings(actor: BrandingActor, teamId: string, input: unknown): Promise<{ changed: boolean }> {
  const next = resolvePageSettings(parsePageSettings(input));
  return withUser(actor.id, async (tx) => {
    const team = await requireTeamAdmin(tx, teamId);
    const before = resolvePageSettings(team.page_settings);
    const diff = changedFields(before, next);
    if (!diff) return { changed: false };
    const stored = toStoredPageSettings(next);
    await tx`update app.teams set page_settings = ${tx.json(stored)} where id = ${teamId}`;
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "team.page_settings_update",
      entityType: "team",
      entityId: teamId,
      before: diff.before,
      after: diff.after,
    });
    return { changed: true };
  });
}

/** Validates and stores a team logo, replacing any existing one. */
export async function uploadTeamLogo(
  actor: BrandingActor,
  teamId: string,
  file: Uint8Array,
  declaredType?: string | null,
): Promise<{ sha256: string; width: number | null; height: number | null; contentType: LogoContentType }> {
  const logo = validateLogo(file, declaredType);
  return withUser(actor.id, async (tx) => {
    await requireTeamAdmin(tx, teamId);
    const [prev] = await tx<{ content_type: string; byte_size: number; sha256: string; width: number | null; height: number | null }[]>`
      select content_type, byte_size, sha256, width, height from app.team_logos where team_id = ${teamId} for update
    `;
    if (prev) {
      await tx`
        update app.team_logos
        set content_type = ${logo.contentType}, bytes = ${logo.bytes}, sha256 = ${logo.sha256},
            width = ${logo.width}, height = ${logo.height}, uploaded_by = ${actor.id}
        where team_id = ${teamId}
      `;
    } else {
      await tx`
        insert into app.team_logos (team_id, content_type, bytes, sha256, width, height, uploaded_by)
        values (${teamId}, ${logo.contentType}, ${logo.bytes}, ${logo.sha256}, ${logo.width}, ${logo.height}, ${actor.id})
      `;
    }
    const after = { content_type: logo.contentType, byte_size: logo.bytes.byteLength, sha256: logo.sha256, width: logo.width, height: logo.height };
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: prev ? "team.logo_replace" : "team.logo_upload",
      entityType: "team",
      entityId: teamId,
      before: prev ?? null,
      after,
    });
    return { sha256: logo.sha256, width: logo.width, height: logo.height, contentType: logo.contentType };
  });
}

export async function removeTeamLogo(actor: BrandingActor, teamId: string): Promise<{ removed: boolean }> {
  return withUser(actor.id, async (tx) => {
    await requireTeamAdmin(tx, teamId);
    const [prev] = await tx<{ content_type: string; byte_size: number; sha256: string; width: number | null; height: number | null }[]>`
      select content_type, byte_size, sha256, width, height from app.team_logos where team_id = ${teamId}
    `;
    if (!prev) return { removed: false };
    await tx`delete from app.team_logos where team_id = ${teamId}`;
    await writeAudit(tx, { actorUserId: actor.id, action: "team.logo_remove", entityType: "team", entityId: teamId, before: prev, after: null });
    return { removed: true };
  });
}
