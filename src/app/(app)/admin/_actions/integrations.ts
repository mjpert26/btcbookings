"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { addAllowedCallback, IntegrationError, registerClientManually, removeAllowedCallback, revokeToken, setClientDisabled } from "@/server/integrations/admin";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, str } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";
import { OAuthError } from "@/server/oauth/server";

async function run(fn: () => Promise<string>): Promise<ActionState> {
  try {
    const message = await audited(fn);
    revalidatePath("/admin/integrations");
    return ok(message);
  } catch (err) {
    if (err instanceof IntegrationError || err instanceof OAuthError) return fail(err.message);
    throw err;
  }
}

export async function addCallbackAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  return run(async () => {
    await addAllowedCallback(user, str(fd, "pattern"), str(fd, "note"));
    return "Callback URL allowed.";
  });
}

export async function removeCallbackAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const id = str(fd, "id");
  if (!z.string().uuid().safeParse(id).success) return fail("Unknown entry.");
  return run(async () => {
    await removeAllowedCallback(user, id);
    return "Callback URL removed. Existing connections keep working until their tokens expire or are revoked.";
  });
}

export async function registerClientAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const name = str(fd, "name");
  const callbacks = str(fd, "callbacks").split(/[\s,]+/).filter(Boolean);
  if (!name) return fail("Name the app.");
  if (!callbacks.length) return fail("Enter at least one callback URL.");
  return run(async () => `Registered. Client ID: ${await registerClientManually(user, name, callbacks)}`);
}

export async function toggleClientAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const clientId = str(fd, "clientId");
  const disable = str(fd, "disable") === "1";
  return run(async () => {
    await setClientDisabled(user, clientId, disable);
    return disable ? "Client disabled and its connections revoked." : "Client enabled.";
  });
}

export async function revokeAnyTokenAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const id = str(fd, "tokenId");
  if (!z.string().uuid().safeParse(id).success) return fail("Unknown token.");
  return run(async () => ((await revokeToken(user, id)) ? "Revoked." : "Already revoked."));
}
