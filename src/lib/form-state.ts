/**
 * Result shape returned by every internal server action that backs a form.
 * fieldErrors keys match the form field names (nested paths joined with ".").
 */
export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Follow-up items to show with a success message, for example bookings to reschedule. */
  warnings?: string[];
  /** Id of the record a successful create added, so related notices can follow its lifetime. */
  createdId?: string;
  /** Changes on every response so repeated identical messages are still announced. */
  ts?: number;
};

export const IDLE: ActionState = { status: "idle" };

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
