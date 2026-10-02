import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/** Job handlers owned by the salesforce module. Keys are job kinds. */
export const salesforceHandlers: Record<string, JobHandler> = {};
