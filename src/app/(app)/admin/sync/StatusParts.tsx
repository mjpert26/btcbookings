import { Badge } from "@/components/ui/Badge";
import { formatRelative } from "@/lib/format";
import type { SyncRun, TeamSyncStatus } from "@/server/sync/status";

/** Short description of one queue sync run: outcome, source and roster changes. */
export function RunSummary({ run, empty = "No queue sync recorded yet" }: { run: SyncRun | null; empty?: string }) {
  if (!run) return <span className="text-sm text-muted">{empty}</span>;
  const tone = run.status === "applied" ? "success" : run.status === "error" ? "danger" : run.status === "blocked" ? "warning" : "neutral";
  const changes = [
    run.added ? `${run.added} added` : null,
    run.removed ? `${run.removed} removed` : null,
    run.reinstated ? `${run.reinstated} reinstated` : null,
    run.promoted ? `${run.promoted} activated` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{run.status}</Badge>
        <span className="text-muted">
          {run.source === "poll" ? "snapshot" : "push"} · {formatRelative(run.last_seen_at)}
          {run.repeat_count > 1 ? ` · ${run.repeat_count} times` : ""}
        </span>
      </div>
      <p>{changes.length ? changes.join(", ") : "No roster changes"}{run.reason ? ` (${run.reason.replace(/_/g, " ")})` : ""}</p>
      {run.reassign_jobs || run.review_bookings ? (
        <p className="text-xs text-muted">
          {run.reassign_jobs ? `${run.reassign_jobs} booking${run.reassign_jobs === 1 ? "" : "s"} queued for reassignment. ` : ""}
          {run.review_bookings ? `${run.review_bookings} booking${run.review_bookings === 1 ? "" : "s"} kept for review.` : ""}
        </p>
      ) : null}
      {run.error ? <p className="break-words text-xs text-danger">{run.error}</p> : null}
    </div>
  );
}

export function SlackJobsSummary({ status }: { status: TeamSyncStatus }) {
  const { pending, retrying, dead } = status.slackJobs;
  if (status.slackChannels === 0 && !status.slackUsergroup) return <span className="text-sm text-muted">No Slack links</span>;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <Badge tone={pending ? "navy" : "neutral"}>{pending} pending</Badge>
      <Badge tone={retrying ? "warning" : "neutral"}>{retrying} retrying</Badge>
      <Badge tone={dead ? "danger" : "neutral"}>{dead} failed</Badge>
    </div>
  );
}

export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return <span className="text-sm text-muted">None</span>;
  return (
    <ul className="max-w-md space-y-1">
      {errors.map((e, i) => (
        <li key={i} className="break-words text-xs text-danger">
          {e}
        </li>
      ))}
    </ul>
  );
}
