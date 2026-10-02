import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/** Job handlers owned by the email module. Keys are job kinds. */
export const emailHandlers: Record<string, JobHandler> = {};
