import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/** Job handlers owned by the slack module. Keys are job kinds. */
export const slackHandlers: Record<string, JobHandler> = {};
