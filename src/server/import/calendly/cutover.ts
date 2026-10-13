import "server-only";
import { withUser, type Tx } from "@/server/db/client";
import { writeAudit } from "@/server/audit";
import { IMPORT_SOURCE } from "@/server/import/calendly/map";

/**
 * Go-live controls for imported booking pages. Imported event types start inactive; an admin
 * activates the ones that were active in Calendly (import_meta.active) per rep, per team or
 * all at once, and can pause them again. Team pages whose Calendly hosts could not be matched
 * (import_meta.needsHosts) wait until hosts are assigned. Going live records
 * import_meta.released_at; until then only admins can activate a page (trigger
 * event_types_guard_imported). Runs as the signed-in admin under RLS and audits every change
 * in the same transaction.
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
  /** Team pages that cannot go live until hosts are assigned. */
  needsHosts: number;
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

/** Pages that may go live: active in Calendly, and (for team pages) with hosts to offer. */
function eligible(tx: Tx) {
  return tx`
    coalesce((et.import_meta ->> 'active')::boolean, false)
    and not (
      coalesce((et.import_meta ->> 'needsHosts')::boolean, false)
      and not exists (select 1 from app.event_type_hosts h where h.event_type_id = et.id)
    )
  `;
}

export async function listImportedPages(actor: Actor): Promise<ImportedPagesRow[]> {
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    return tx<ImportedPagesRow[]>`
      with imported as (
        select et.id, et.team_id, et.owner_user_id, et.is_active, (${eligible(tx)}) as eligible,
               coalesce((et.import_meta ->> 'needsHosts')::boolean, false)
                 and not exists (select 1 from app.event_type_hosts h where h.event_type_id = et.id) as needs_hosts
        from app.event_types et
        where et.import_source = ${IMPORT_SOURCE}
      ),
      -- Hosts of a team's imported pages: their assigned hosts, or every active member when a
      -- page has no host list (it uses the whole team).
      team_hosts as (
        select distinct i.team_id, tm.user_id
        from imported i
        join app.team_members tm on tm.team_id = i.team_id and tm.status = 'active' and tm.user_id is not null
        where exists (select 1 from app.event_type_hosts h where h.event_type_id = i.id and h.team_member_id = tm.id)
           or not exists (select 1 from app.event_type_hosts h where h.event_type_id = i.id)
      )
      select 'team' as kind, t.id, t.name, t.slug,
             count(*) filter (where i.eligible and not i.is_active)::int as ready,
             count(*) filter (where i.needs_hosts)::int as "needsHosts",
             count(*) filter (where i.is_active)::int as live,
             (select count(*) from team_hosts th
                join app.calendar_connections cc on cc.user_id = th.user_id and cc.status = 'healthy'
              where th.team_id = t.id)::int as connected,
             (select count(*) from team_hosts th where th.team_id = t.id)::int as hosts
      from imported i join app.teams t on t.id = i.team_id
      group by t.id, t.name, t.slug
      union all
      select 'user' as kind, u.id, u.name, u.slug,
             count(*) filter (where i.eligible and not i.is_active)::int,
             0,
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
  if (scope.kind === "team") return tx`and et.team_id = ${scope.teamId}`;
  if (scope.kind === "user") return tx`and et.owner_user_id = ${scope.userId}`;
  return tx``;
}

/** Activates imported pages in scope that were active in Calendly. Returns how many went live. */
export async function goLiveImportedPages(actor: Actor, scope: CutoverScope): Promise<number> {
  return withUser(actor.id, async (tx) => {
    await assertAdmin(tx);
    const rows = await tx<{ id: string }[]>`
      update app.event_types et
      set is_active = true, updated_at = now(),
          import_meta = coalesce(et.import_meta, '{}'::jsonb) || jsonb_build_object('released_at', now())
      where et.import_source = ${IMPORT_SOURCE} and not et.is_active
        and ${eligible(tx)}
        ${scopeFilter(tx, scope)}
      returning et.id
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
    // Paused pages return to the dormant state: only the cutover can take them live again.
    const rows = await tx<{ id: string }[]>`
      update app.event_types et
      set is_active = false, updated_at = now(), import_meta = coalesce(et.import_meta, '{}'::jsonb) - 'released_at'
      where et.import_source = ${IMPORT_SOURCE} and et.is_active
        ${scopeFilter(tx, scope)}
      returning et.id
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
