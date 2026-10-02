"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { withUser, type Tx } from "@/server/db/client";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, json, ok, str, zodFieldErrors } from "@/server/ui/form";
import { DEFAULT_WEEKLY, intervalListSchema, SHOW_AS_VALUES, timeZoneSchema, weeklyRulesSchema } from "@/lib/availability";

/** Returns the user's default schedule id, creating it from the standard template if missing. */
async function ensureDefaultSchedule(tx: Tx, userId: string, timezone: string): Promise<string> {
  const [existing] = await tx<{ id: string }[]>`
    select id from app.availability_schedules where owner_user_id = ${userId} and is_default
  `;
  if (existing) return existing.id;
  // No RETURNING: the SELECT policy's security-definer check cannot see a row inserted by
  // the same statement, so the id is generated here.
  const id = randomUUID();
  await tx`
    insert into app.availability_schedules (id, owner_user_id, name, timezone, weekly_rules, is_default)
    values (${id}, ${userId}, 'Working hours', ${timezone}, ${tx.json(DEFAULT_WEEKLY)}, true)
  `;
  return id;
}

export async function saveWeeklyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const tz = timeZoneSchema.safeParse(str(fd, "timezone"));
  const weekly = weeklyRulesSchema.safeParse(json(fd, "weekly"));
  if (!tz.success || !weekly.success) {
    const errors: Record<string, string> = {};
    if (!tz.success) errors.timezone = tz.error.issues[0]?.message ?? "Invalid time zone.";
    if (!weekly.success) for (const [k, v] of Object.entries(zodFieldErrors(weekly.error))) errors[`weekly.${k.split(".")[0]}`] ??= v;
    return fail("Please fix the highlighted fields.", errors);
  }
  await withUser(user.id, async (tx) => {
    const id = await ensureDefaultSchedule(tx, user.id, tz.data);
    await tx`
      update app.availability_schedules
      set timezone = ${tz.data}, weekly_rules = ${tx.json(weekly.data)}
      where id = ${id}
    `;
  });
  revalidatePath("/availability");
  return ok("Weekly hours saved.");
}

const overrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."),
  intervals: intervalListSchema,
});

export async function addOverrideAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = overrideSchema.safeParse({ date: str(fd, "date"), intervals: json(fd, "intervals") ?? [] });
  if (!parsed.success) return invalid(parsed.error);
  await withUser(user.id, async (tx) => {
    const id = await ensureDefaultSchedule(tx, user.id, user.timezone);
    await tx`
      insert into app.availability_overrides (schedule_id, date, intervals)
      values (${id}, ${parsed.data.date}, ${tx.json(parsed.data.intervals)})
      on conflict (schedule_id, date) do update set intervals = excluded.intervals
    `;
  });
  revalidatePath("/availability");
  return ok(parsed.data.intervals.length ? "Custom hours saved for that date." : "Marked unavailable for that date.");
}

export async function removeOverrideAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = str(fd, "overrideId");
  if (!isUuid(id)) return fail("Invalid override.");
  const rows = await withUser(user.id, (tx) => tx`delete from app.availability_overrides where id = ${id} returning id`);
  if (!rows.length) return fail("Override not found.");
  revalidatePath("/availability");
  return ok("Override removed.");
}

const settingsSchema = z.object({
  unavailableShowAs: z.array(z.enum(SHOW_AS_VALUES)).min(1, "Choose at least one Outlook status that blocks time."),
  dailyBookingCap: z
    .union([z.literal(""), z.coerce.number().int("Use a whole number.").min(1, "Must be at least 1.").max(50, "At most 50.")])
    .transform((v) => (v === "" ? null : v)),
  outlookConflictPolicy: z.enum(["auto_cancel", "flag"]),
  notifyHostByEmail: z.boolean(),
});

export async function saveSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = settingsSchema.safeParse({
    unavailableShowAs: fd.getAll("unavailableShowAs").map(String),
    dailyBookingCap: str(fd, "dailyBookingCap"),
    outlookConflictPolicy: str(fd, "outlookConflictPolicy"),
    notifyHostByEmail: bool(fd, "notifyHostByEmail"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const s = parsed.data;
  await withUser(user.id, (tx) => tx`
    insert into app.user_settings (user_id, unavailable_show_as, daily_booking_cap, outlook_conflict_policy, notify_host_by_email)
    values (${user.id}, ${s.unavailableShowAs}, ${s.dailyBookingCap}, ${s.outlookConflictPolicy}, ${s.notifyHostByEmail})
    on conflict (user_id) do update set
      unavailable_show_as = excluded.unavailable_show_as,
      daily_booking_cap = excluded.daily_booking_cap,
      outlook_conflict_policy = excluded.outlook_conflict_policy,
      notify_host_by_email = excluded.notify_host_by_email
  `);
  revalidatePath("/availability");
  return ok("Booking preferences saved.");
}
