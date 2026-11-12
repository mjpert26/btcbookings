"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { removeIntegrationSetting, setIntegrationSetting, SettingsError } from "@/server/settings/admin";
import { CHECK_SERVICES, runSettingsCheck } from "@/server/settings/checks";
import { MANAGED_KEYS } from "@/server/settings/keys";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, str } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";

const PATH = "/admin/settings";

const keySchema = z.enum(MANAGED_KEYS, { message: "Unknown setting." });
const serviceSchema = z.enum(CHECK_SERVICES, { message: "Unknown check." });

function settingsError(err: unknown): ActionState {
  if (err instanceof SettingsError) return fail(err.message, err.code === "invalid" ? { value: err.message } : undefined);
  throw err;
}

/** Sets or replaces one key. The value is never echoed back. */
export async function saveSettingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const key = keySchema.safeParse(str(fd, "key"));
  if (!key.success) return fail("Unknown setting.");
  const raw = fd.get("value");
  try {
    await audited(() => setIntegrationSetting(user, key.data, typeof raw === "string" ? raw : ""));
  } catch (err) {
    return settingsError(err);
  }
  revalidatePath(PATH);
  return ok(`${key.data} saved. It is used everywhere within 30 seconds.`);
}

/** Removes one key's panel value; the Vercel value (if any) applies again. */
export async function removeSettingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const key = keySchema.safeParse(str(fd, "key"));
  if (!key.success) return fail("Unknown setting.");
  let after;
  try {
    after = await audited(() => removeIntegrationSetting(user, key.data));
  } catch (err) {
    return settingsError(err);
  }
  revalidatePath(PATH);
  const fallback = after.source === "vercel" ? "the Vercel value applies again" : after.source === "default" ? "the default applies again" : "it is now not set";
  return ok(`${key.data} removed from Admin > Settings; ${fallback}.`);
}

/** Runs a test button. Never contacts anyone other than the signed-in admin. */
export async function testSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const service = serviceSchema.safeParse(str(fd, "service"));
  if (!service.success) return fail("Unknown check.");
  try {
    const result = await audited(() => runSettingsCheck(user, service.data));
    return result.ok ? ok(result.message) : fail(result.message);
  } catch (err) {
    return settingsError(err);
  }
}
