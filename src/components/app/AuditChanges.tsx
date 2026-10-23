import { fieldLabel, formatAuditValue, type FieldChange } from "@/lib/audit-diff";

/** A compact field-level diff of one audit entry: field, old value, new value. */
export function AuditChanges({ changes, zone, empty = "No field changes recorded." }: { changes: FieldChange[]; zone: string; empty?: string }) {
  if (!changes.length) return <p className="text-xs text-muted">{empty}</p>;
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
      {changes.map((c) => (
        <div key={JSON.stringify(c.path)} className="contents">
          <dt className="font-medium text-navy">{fieldLabel(c.path)}</dt>
          <dd className="min-w-0 break-words text-ink">
            {c.before !== undefined ? (
              <>
                <span className="text-muted line-through decoration-muted/60">{formatAuditValue(c.before, zone)}</span>
                <span aria-hidden="true" className="px-1 text-muted">
                  →
                </span>
                <span className="sr-only"> changed to </span>
              </>
            ) : null}
            <span>{formatAuditValue(c.after, zone)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
