import "server-only";
import type { ActionState } from "@/lib/form-state";
import type { TimeOffInput } from "@/lib/time-off";
import { formatRange } from "@/lib/format";
import { bool, ok, str } from "@/server/ui/form";
import type { OverlappingBooking } from "@/server/time-off";

/** Reads the time-off form fields. The All day switch posts "on" or "off". */
export function timeOffFormValues(fd: FormData): TimeOffInput {
  return {
    allDay: bool(fd, "allDay"),
    startDate: str(fd, "startDate"),
    endDate: str(fd, "endDate"),
    startTime: str(fd, "startTime"),
    endTime: str(fd, "endTime"),
    note: str(fd, "note"),
  };
}

/**
 * Success state after adding time off. Each confirmed booking inside the block becomes a
 * warning line (time in the block's zone and invitee name) so it can be rescheduled. The
 * block id is returned so the form can hide the warning once the block is deleted.
 */
export function timeOffSavedState(blockId: string, overlapping: OverlappingBooking[], zone: string): ActionState {
  const n = overlapping.length;
  const state = ok(
    n === 0
      ? "Time off added."
      : `Time off added. ${n === 1 ? "1 booking falls" : `${n} bookings fall`} inside it and ${n === 1 ? "was" : "were"} not changed.`,
  );
  state.createdId = blockId;
  if (n) state.warnings = overlapping.map((b) => `${formatRange(b.startAt, b.endAt, zone)} · ${b.inviteeName}`);
  return state;
}
