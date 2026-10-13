import "server-only";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { IMPORT_SOURCE } from "@/server/import/calendly/map";

/**
 * Go-live controls for imported booking pages. Imported event types start inactive; an admin
 * activates the ones that were active in Calendly (import_meta.active) per rep, per team or
 * all at once, and can pause them again. Runs as the signed-in admin under RLS and audits
 * every change in the same transaction.
 */

export type Actor = { id: string };

export type CutoverScope = { kind: "all" } | { kind: "team"; teamId: string } | { kind: "user"; userId: string };

export type ImportedPagesRow = {
  kind: "team" | "user";
  id: string;
  name: string;
  slug: string;
  /** Pages that were active in Calendly and are not live here yet. */
  ready: number;
  live: number;
  /** Hosts with a healthy Outlook connection, and all hosts. */
  connected: number;
  hosts: number;
};

export class CutoverForbiddenError extends Error {
  constructor() {
    super("Admin access required");
    this.name = "CutoverForbiddenError";
  }
}

async function assertAdmin(tx: Tx): Promise<void> {
  const [r] = await tx<{ ok: boolean }[]>`select app.is_admin() as ok`;
  if (!r?.ok) throw new CutoverForbiddenError();
}

export async function listImportedPages(actor: Actor): Promise<ImportedPagesRow[]> {
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    return tx<ImportedPagesRow[]>`
      with imported as (
        select et.team_id, et.owner_user_id, et.is_active,
               coalesce((et.import_meta ->> 'active')::boolean, false) as calendly_active
        from app.event_types et
        where et.import_source = ${IMPORT_SOURCE}
      )
      select 'team' as kind, t.id, t.name, t.slug,
             count(*) filter (where i.calendly_active and not i.is_active)::int as ready,
             count(*) filter (where i.is_active)::int as live,
             (select count(*) from app.team_members tm
                join app.calendar_connections cc on cc.user_id = tm.user_id and cc.status = 'healthy'
              where tm.team_id = t.id and tm.status = 'active')::int as connected,
             (select count(*) from app.team_members tm where tm.team_id = t.id and tm.status = 'active')::int as hosts
      from imported i join app.teams t on t.id = i.team_id
      group by t.id, t.name, t.slug
      union all
      select 'user' as kind, u.id, u.name, u.slug,
             count(*) filter (where i.calendly_active and not i.is_active)::int,
             count(*) filter (where i.is_active)::int,
             (case when bool_or(cc.status = 'healthy') then 1 else 0 end)::int,
             1
      from imported i
      join app.users u on u.id = i.owner_user_id
      left join app.calendar_connections cc on cc.user_id = u.id
      group by u.id, u.name, u.slug
      order by kind, name
    `;
  });
}

function scopeFilter(tx: Tx, scope: CutoverScope) {
  if (scope.kind === "team") return tx`and team_id = ${scope.teamId}`;
  if (scope.kind === "user") return tx`and owner_user_id = ${scope.userId}`;
  return tx``;
}

/** Activates imported pages in scope that were active in Calendly. Returns how many went live. */
export async function goLiveImportedPages(actor: Actor, scope: CutoverScope): Promise<number> {
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    const rows = await tx<{ id: string }[]>`
      update app.event_types set is_active = true, updated_at = now()
      where import_source = ${IMPORT_SOURCE} and not is_active
        and coalesce((import_meta ->> 'active')::boolean, false)
        ${scopeFilter(tx, scope)}
      returning id
    `;
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "import.calendly.go_live",
      entityType: scope.kind === "team" ? "team" : scope.kind === "user" ? "user" : "import",
      entityId: scope.kind === "team" ? scope.teamId : scope.kind === "user" ? scope.userId : null,
      after: { scope: scope.kind, eventTypeIds: rows.map((r) => r.id) },
    });
    return rows.length;
  });
}

/** Deactivates imported pages in scope. Returns how many were paused. */
export async function pauseImportedPages(actor: Actor, scope: CutoverScope): Promise<number> {
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    const rows = await tx<{ id: string }[]>`
      update app.event_types set is_active = false, updated_at = now()
      where import_source = ${IMPORT_SOURCE} and is_active
        ${scopeFilter(tx, scope)}
      returning id
    `;
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "import.calendly.pause",
      entityType: scope.kind === "team" ? "team" : scope.kind === "user" ? "user" : "import",
      entityId: scope.kind === "team" ? scope.teamId : scope.kind === "user" ? scope.userId : null,
      after: { scope: scope.kind, eventTypeIds: rows.map((r) => r.id) },
    });
    return rows.length;
  });
}
