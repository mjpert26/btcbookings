"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { cancelBookingAsHost } from "@/server/booking/host-actions";
import type { ActionState } from "@/lib/form-state";
import { fail, invalid, ok, str } from "@/server/ui/form";

const cancelSchema = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().max(500, "Keep the reason under 500 characters.").optional(),
});

export async function cancelBookingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = cancelSchema.safeParse({ bookingId: str(fd, "bookingId"), reason: str(fd, "reason") || undefined });
  if (!parsed.success) return invalid(parsed.error);
  const res = await cancelBookingAsHost(user.id, parsed.data.bookingId, parsed.data.reason ?? null);
  if (!res.ok) {
    return fail(res.reason === "not_found" ? "Booking not found." : "This booking can no longer be cancelled.");
  }
  revalidatePath(`/bookings/${parsed.data.bookingId}`);
  revalidatePath("/bookings");
  revalidatePath("/dashboard");
  return ok(res.alreadyCancelled ? "This booking was already cancelled." : "Booking cancelled. The invitee will be notified and the Outlook event removed.");
}
