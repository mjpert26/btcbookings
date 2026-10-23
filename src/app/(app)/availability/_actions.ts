"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { withUser, type Tx } from "@/server/db/client";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, json, ok, requestIpHash, str, zodFieldErrors } from "@/server/ui/form";
import { DEFAULT_WEEKLY, intervalListSchema, SHOW_AS_VALUES, timeZoneSchema, weeklyRulesSchema } from "@/lib/availability";
import { normalizeE164 } from "@/server/sms/phone";
import { changedFields, maskPhone, writeAudit, writeAuditDiff } from "@/server/audit";

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
  const ipHash = await requestIpHash();
  await withUser(user.id, async (tx) => {
    const id = await ensureDefaultSchedule(tx, user.id, tz.data);
    const [before] = await tx<{ timezone: string; weekly_rules: unknown }[]>`
      select timezone, weekly_rules from app.availability_schedules where id = ${id}
    `;
    await tx`
      update app.availability_schedules
      set timezone = ${tz.data}, weekly_rules = ${tx.json(weekly.data)}
      where id = ${id}
    `;
    await writeAuditDiff(tx, {
      actorUserId: user.id,
      action: "availability.weekly_update",
      entityType: "availability_schedule",
      entityId: id,
      before: { timezone: before?.timezone ?? null, weekly_rules: before?.weekly_rules ?? null },
      after: { timezone: tz.data, weekly_rules: weekly.data },
      ipHash,
    });
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
  const ipHash = await requestIpHash();
  await withUser(user.id, async (tx) => {
    const id = await ensureDefaultSchedule(tx, user.id, user.timezone);
    const { date, intervals } = parsed.data;
    const [prev] = await tx<{ intervals: unknown }[]>`
      select intervals from app.availability_overrides where schedule_id = ${id} and date = ${date}
    `;
    await tx`
      insert into app.availability_overrides (schedule_id, date, intervals)
      values (${id}, ${date}, ${tx.json(intervals)})
      on conflict (schedule_id, date) do update set intervals = excluded.intervals
    `;
    // Keyed by date so the entry reads "2026-11-27: 09:00-12:00 -> unavailable".
    await writeAuditDiff(tx, {
      actorUserId: user.id,
      action: "availability.override_set",
      entityType: "availability_schedule",
      entityId: id,
      before: { [date]: prev ? prev.intervals : null } as Record<string, unknown>,
      after: { [date]: intervals },
      ipHash,
    });
  });
  revalidatePath("/availability");
  return ok(parsed.data.intervals.length ? "Custom hours saved for that date." : "Marked unavailable for that date.");
}

export async function removeOverrideAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = str(fd, "overrideId");
  if (!isUuid(id)) return fail("Invalid override.");
  const ipHash = await requestIpHash();
  const removed = await withUser(user.id, async (tx) => {
    const rows = await tx<{ schedule_id: string; date: string; intervals: unknown }[]>`
      delete from app.availability_overrides where id = ${id} returning schedule_id, date::text as date, intervals
    `;
    const row = rows[0];
    if (!row) return false;
    await writeAudit(tx, {
      actorUserId: user.id,
      action: "availability.override_remove",
      entityType: "availability_schedule",
      entityId: row.schedule_id,
      before: { [row.date]: row.intervals },
      after: { [row.date]: null },
      ipHash,
    });
    return true;
  });
  if (!removed) return fail("Override not found.");
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
  smsPhone: z
    .string()
    .trim()
    .max(40)
    .transform((v, ctx) => {
      if (!v) return null;
      const e164 = normalizeE164(v);
      if (!e164) {
        ctx.addIssue({ code: "custom", message: "Enter a mobile number such as (555) 123-4567 or +44 20 7946 0958." });
        return z.NEVER;
      }
      return e164;
    }),
});

export async function saveSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = settingsSchema.safeParse({
    unavailableShowAs: fd.getAll("unavailableShowAs").map(String),
    dailyBookingCap: str(fd, "dailyBookingCap"),
    outlookConflictPolicy: str(fd, "outlookConflictPolicy"),
    notifyHostByEmail: bool(fd, "notifyHostByEmail"),
    smsPhone: str(fd, "smsPhone"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const s = parsed.data;
  const ipHash = await requestIpHash();
  await withUser(user.id, async (tx) => {
    const [prev] = await tx<PreferenceColumns[]>`
      select unavailable_show_as, daily_booking_cap, outlook_conflict_policy, notify_host_by_email, sms_phone
      from app.user_settings where user_id = ${user.id}
    `;
    await tx`
      insert into app.user_settings (user_id, unavailable_show_as, daily_booking_cap, outlook_conflict_policy, notify_host_by_email, sms_phone)
      values (${user.id}, ${s.unavailableShowAs}, ${s.dailyBookingCap}, ${s.outlookConflictPolicy}, ${s.notifyHostByEmail}, ${s.smsPhone})
      on conflict (user_id) do update set
        unavailable_show_as = excluded.unavailable_show_as,
        daily_booking_cap = excluded.daily_booking_cap,
        outlook_conflict_policy = excluded.outlook_conflict_policy,
        notify_host_by_email = excluded.notify_host_by_email,
        sms_phone = excluded.sms_phone
    `;
    await auditPreferences(tx, user.id, prev ?? null, {
      unavailable_show_as: s.unavailableShowAs,
      daily_booking_cap: s.dailyBookingCap,
      outlook_conflict_policy: s.outlookConflictPolicy,
      notify_host_by_email: s.notifyHostByEmail,
      sms_phone: s.smsPhone,
    }, ipHash);
  });
  revalidatePath("/availability");
  return ok("Booking preferences saved.");
}

type PreferenceColumns = {
  unavailable_show_as: string[];
  daily_booking_cap: number | null;
  outlook_conflict_policy: string;
  notify_host_by_email: boolean;
  sms_phone: string | null;
};

/**
 * Records the booking preferences that changed. The SMS number is compared in full but stored
 * masked to its last four digits.
 */
async function auditPreferences(tx: Tx, userId: string, prev: PreferenceColumns | null, next: PreferenceColumns, ipHash: string | null): Promise<void> {
  // No row yet: every saved value counts as a change from "not set".
  const empty = { unavailable_show_as: null, daily_booking_cap: null, outlook_conflict_policy: null, notify_host_by_email: null, sms_phone: null } as unknown as PreferenceColumns;
  const diff = changedFields<PreferenceColumns>(prev ?? empty, next);
  if (!diff) return;
  if ("sms_phone" in diff.after) {
    diff.before.sms_phone = maskPhone(diff.before.sms_phone);
    diff.after.sms_phone = maskPhone(diff.after.sms_phone);
  }
  await writeAudit(tx, { actorUserId: userId, action: "user_settings.update", entityType: "user_settings", entityId: userId, ...diff, ipHash });
}
