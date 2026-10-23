import type { Tx } from "@/server/db/client";

export type JobRow = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  booking_id: string | null;
  team_id: string | null;
};

export type AttemptLog = {
  /** Redacted summary of the outbound request. Never include tokens or secrets. */
  request?: Record<string, unknown>;
  responseCode?: number;
};

export type JobContext = {
  /** Record details about this attempt for the admin UI. */
  log: (entry: AttemptLog) => void;
};

export type JobResult = { result?: Record<string, unknown> } | void;

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobResult>;

/** Throw to stop retrying immediately (bad input, permanent upstream rejection). */
export class PermanentJobError extends Error {
  constructor(message: string, readonly result?: Record<string, unknown>) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Throw to retry at a specific time (e.g. Slack Retry-After). */
export class RetryAfterError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = "RetryAfterError";
  }
}

/**
 * Throw to run the job again later without using up an attempt: the job waits on other
 * work (for example an earlier job of the same booking chain) rather than failing. The
 * attempt is not counted and not recorded in job_attempts.
 */
export class DeferJobError extends Error {
  constructor(message: string, readonly delaySeconds: number) {
    super(message);
    this.name = "DeferJobError";
  }
}

export type EnqueueInput = {
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  bookingId?: string | null;
  teamId?: string | null;
};

export type EnqueueFn = (db: Tx, input: EnqueueInput) => Promise<string | null>;
