import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { DeleteTimeOff } from "@/components/app/TimeOff";
import type { FormAction } from "@/lib/form-state";
import { formatTimeOff } from "@/lib/time-off";

export type TimeOffListItem = {
  id: string;
  userId: string;
  userName: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timezone: string;
  note: string | null;
  createdBy: string | null;
  createdByName: string | null;
};

/**
 * Current and upcoming time-off blocks. Renders a Delete button per block when
 * `deleteAction` is given (omit it for read-only viewers). `overlaps` maps a block id to
 * the bookings inside it, already formatted.
 */
export function TimeOffList({
  blocks,
  deleteAction,
  showUser = false,
  overlaps,
  now,
  emptyDescription = "Upcoming days off and blocked hours will appear here.",
}: {
  blocks: TimeOffListItem[];
  deleteAction?: FormAction;
  showUser?: boolean;
  overlaps?: Record<string, string[]>;
  now: Date;
  emptyDescription?: string;
}) {
  if (blocks.length === 0) return <EmptyState title="No time off" description={emptyDescription} />;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {blocks.map((b) => {
        const label = formatTimeOff(b);
        const inside = overlaps?.[b.id] ?? [];
        return (
          <li key={b.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0 text-sm">
              {showUser ? <p className="font-semibold text-navy">{b.userName}</p> : null}
              <p className={showUser ? "text-ink" : "font-semibold text-navy"}>
                {label}
                {b.startsAt <= now ? (
                  <Badge tone="warning" className="ml-2">
                    Now
                  </Badge>
                ) : null}
              </p>
              {b.note ? <p className="break-words text-muted">{b.note}</p> : null}
              {b.createdBy && b.createdBy !== b.userId ? <p className="text-xs text-muted">Added by {b.createdByName ?? "a deleted user"}</p> : null}
              {inside.length ? (
                <div className="mt-1 text-xs text-warning">
                  <p className="font-semibold">
                    {inside.length === 1 ? "1 booking is" : `${inside.length} bookings are`} inside this time off and still confirmed:
                  </p>
                  <ul className="list-disc pl-4">
                    {inside.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            {deleteAction ? <DeleteTimeOff action={deleteAction} id={b.id} label={showUser ? `${b.userName}, ${label}` : label} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
