import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/** Job handlers owned by the sync module. Keys are job kinds. */
export const syncHandlers: Record<string, JobHandler> = {};
