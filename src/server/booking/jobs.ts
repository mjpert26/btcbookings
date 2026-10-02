import "server-only";
import type { JobHandler } from "@/server/jobs/types";

/** Job handlers owned by the booking module. Keys are job kinds. */
export const bookingHandlers: Record<string, JobHandler> = {};
