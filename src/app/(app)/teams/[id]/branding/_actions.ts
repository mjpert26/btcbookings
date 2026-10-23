"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireUser } from "@/server/auth/session";
import type { ActionState } from "@/lib/form-state";
import { bool, fail, invalid, isUuid, ok } from "@/server/ui/form";
import { audited, sentence } from "@/server/ui/admin";
import { removeTeamLogo, savePageSettings, TeamBrandingError, uploadTeamLogo } from "@/server/teams/branding";
import { LOGO_MAX_BYTES, LogoValidationError } from "@/server/teams/logo";
import { PAGE_SETTING_TOGGLES } from "@/server/teams/page-settings";

/*
 * Branding changes for a partner's public pages. Authorization (team admin or global admin),
 * validation and the audit entry live in src/server/teams/branding.ts; these actions only
 * read the form and turn known errors into form messages.
 */

function brandingError(err: unknown, field?: string): ActionState {
  if (err instanceof ZodError) return invalid(err);
  if (err instanceof LogoValidationError) return fail(sentence(err.message), field ? { [field]: sentence(err.message) } : undefined);
  if (err instanceof TeamBrandingError) {
    if (err.code === "forbidden") return fail("You do not have permission to do that. Only team admins can change branding.");
    return fail(sentence(err.message));
  }
  throw err;
}

/** A text field, or undefined when left empty (the setting then uses its default). */
function optionalText(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

export async function saveBrandingAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(teamId)) return fail("Team not found.");
  const input: Record<string, unknown> = {
    displayName: optionalText(fd, "displayName"),
    accentColor: optionalText(fd, "accentColor"),
    heading: optionalText(fd, "heading"),
    intro: optionalText(fd, "intro"),
  };
  for (const key of PAGE_SETTING_TOGGLES) input[key] = bool(fd, key);
  for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
  let res;
  try {
    res = await audited(() => savePageSettings(user, teamId, input));
  } catch (err) {
    return brandingError(err);
  }
  if (!res.changed) return ok("No changes to save.");
  revalidatePath(`/teams/${teamId}/branding`);
  return ok("Branding saved. Public pages show the changes right away.");
}

export async function uploadLogoAction(teamId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(teamId)) return fail("Team not found.");
  const file = fd.get("logo");
  if (!(file instanceof File) || file.size === 0) return fail("Choose an image file.", { logo: "Choose a PNG, JPEG or WebP file." });
  if (file.size > LOGO_MAX_BYTES) return fail("The logo must be 512 KB or smaller.", { logo: "The logo must be 512 KB or smaller." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await audited(() => uploadTeamLogo(user, teamId, bytes, file.type));
  } catch (err) {
    return brandingError(err, "logo");
  }
  revalidatePath(`/teams/${teamId}/branding`);
  return ok("Logo uploaded.");
}

export async function removeLogoAction(teamId: string): Promise<ActionState> {
  const user = await requireUser();
  if (!isUuid(teamId)) return fail("Team not found.");
  let res;
  try {
    res = await audited(() => removeTeamLogo(user, teamId));
  } catch (err) {
    return brandingError(err);
  }
  revalidatePath(`/teams/${teamId}/branding`);
  return ok(res.removed ? "Logo removed." : "There was no logo to remove.");
}
