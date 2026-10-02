import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/**
 * Job handlers owned by the sync module. Keys are job kinds.
 *
 * Queue sync applies membership changes synchronously and only enqueues jobs for other
 * modules (slack_membership_sync for slack, booking_reassign for booking), so it has no
 * handlers of its own.
 */
export const syncHandlers: Record<string, JobHandler> = {};
