import "server-only";
import type { JobHandler } from "@/server/jobs/types";
import { graphHandlers } from "@/server/graph/jobs";
import { slackHandlers } from "@/server/slack/jobs";
import { salesforceHandlers } from "@/server/salesforce/jobs";
import { emailHandlers } from "@/server/email/jobs";
import { bookingHandlers } from "@/server/booking/jobs";
import { syncHandlers } from "@/server/sync/jobs";

export const jobHandlers: Record<string, JobHandler> = {
  ...graphHandlers,
  ...slackHandlers,
  ...salesforceHandlers,
  ...emailHandlers,
  ...bookingHandlers,
  ...syncHandlers,
};
