/**
 * Result shape returned by every internal server action that backs a form.
 * fieldErrors keys match the form field names (nested paths joined with ".").
 */
export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Changes on every response so repeated identical messages are still announced. */
  ts?: number;
};

export const IDLE: ActionState = { status: "idle" };

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
