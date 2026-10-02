"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/ui/Badge";
import { controlClass } from "@/components/ui/Field";
import { useFieldError } from "@/components/ui/Form";
import { cn } from "@/lib/cn";

export type MemberOption = { id: string; name: string; email: string; status: string; weight: number; priority_tier: number };
export type HostValue = { teamMemberId: string; isRequired: boolean; weightOverride: number | null; priorityTierOverride: number | null };

function numOrNull(v: string, min: number, max: number): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Host pool for a team event type. An empty pool means every active team member is eligible.
 * Serializes to the hidden "hosts" field as JSON.
 */
export function HostsEditor({ members, initial, mode }: { members: MemberOption[]; initial: HostValue[]; mode: "round_robin" | "collective" }) {
  const [hosts, setHosts] = useState<Record<string, HostValue>>(() => Object.fromEntries(initial.map((h) => [h.teamMemberId, h])));
  const err = useFieldError("hosts");
  const selected = Object.values(hosts);

  function set(id: string, patch: Partial<HostValue> | null) {
    setHosts((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[id];
      else next[id] = { ...(prev[id] ?? { teamMemberId: id, isRequired: true, weightOverride: null, priorityTierOverride: null }), ...patch };
      return next;
    });
  }

  if (members.length === 0) {
    return <p className="text-sm text-muted">This team has no members yet. Add members on the team page.</p>;
  }

  return (
    <div className="space-y-3">
      <input type="hidden" name="hosts" value={JSON.stringify(selected)} />
      <p className="text-sm text-muted">
        {selected.length === 0
          ? "No hosts selected: every active team member is in the pool."
          : `${selected.length} of ${members.length} members selected.`}{" "}
        Weight and tier overrides apply to this event type only.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Host pool</caption>
          <thead className="bg-surface-alt text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">
                In pool
              </th>
              <th scope="col" className="px-3 py-2">
                Member
              </th>
              {mode === "collective" ? (
                <th scope="col" className="px-3 py-2">
                  Required
                </th>
              ) : null}
              <th scope="col" className="px-3 py-2">
                Weight
              </th>
              <th scope="col" className="px-3 py-2">
                Tier
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => {
              const h = hosts[m.id];
              return (
                <tr key={m.id} className={cn(!h && "text-muted")}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      id={`host-${m.id}`}
                      checked={Boolean(h)}
                      onChange={(e) => set(m.id, e.target.checked ? {} : null)}
                      className="size-4 accent-primary"
                      aria-describedby={`host-${m.id}-name`}
                    />
                    <label htmlFor={`host-${m.id}`} className="sr-only">
                      Include {m.name}
                    </label>
                  </td>
                  <td className="px-3 py-2" id={`host-${m.id}-name`}>
                    <span className="font-medium text-navy">{m.name}</span> <StatusBadge status={m.status} />
                    <div className="text-xs text-muted">{m.email}</div>
                  </td>
                  {mode === "collective" ? (
                    <td className="px-3 py-2">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" disabled={!h} checked={h?.isRequired ?? true} onChange={(e) => set(m.id, { isRequired: e.target.checked })} className="size-4 accent-primary" />
                        <span className="sr-only">{m.name} is required</span>
                        <span aria-hidden="true">Required</span>
                      </label>
                    </td>
                  ) : null}
                  <td className="px-3 py-2">
                    <label className="sr-only" htmlFor={`w-${m.id}`}>
                      Weight override for {m.name}
                    </label>
                    <input
                      id={`w-${m.id}`}
                      type="number"
                      min={0}
                      max={1000}
                      disabled={!h}
                      placeholder={String(m.weight)}
                      value={h?.weightOverride ?? ""}
                      onChange={(e) => set(m.id, { weightOverride: numOrNull(e.target.value, 0, 1000) })}
                      className={cn(controlClass, "w-24")}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <label className="sr-only" htmlFor={`t-${m.id}`}>
                      Priority tier override for {m.name}
                    </label>
                    <input
                      id={`t-${m.id}`}
                      type="number"
                      min={1}
                      max={10}
                      disabled={!h}
                      placeholder={String(m.priority_tier)}
                      value={h?.priorityTierOverride ?? ""}
                      onChange={(e) => set(m.id, { priorityTierOverride: numOrNull(e.target.value, 1, 10) })}
                      className={cn(controlClass, "w-20")}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {err ? <p className="text-sm font-medium text-danger">{err}</p> : null}
    </div>
  );
}
