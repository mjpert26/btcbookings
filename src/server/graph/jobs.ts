import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/** Job handlers owned by the graph module. Keys are job kinds. */
export const graphHandlers: Record<string, JobHandler> = {};
