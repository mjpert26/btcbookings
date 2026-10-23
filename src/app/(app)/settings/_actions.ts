"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { createMyApiKey, disconnectApp, IntegrationError, revokeToken } from "@/server/integrations/admin";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, str } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";
import { OAuthError } from "@/server/oauth/server";

export type NewKeyState = { status: "idle" | "success" | "error"; message?: string; key?: string; ts?: number };

const keySchema = z.object({
  name: z.string().trim().min(1, "Name the key.").max(100),
  expires: z.enum(["30", "90", "365", "never"]),
});

/** Creates an API key and returns it once. It is never shown again. */
export async function createApiKeyAction(_prev: NewKeyState, fd: FormData): Promise<NewKeyState> {
  const user = await requireUser();
  const parsed = keySchema.safeParse({ name: str(fd, "name"), expires: str(fd, "expires") || "90" });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid request.", ts: Date.now() };
  try {
    const days = parsed.data.expires === "never" ? null : Number(parsed.data.expires);
    const { key } = await audited(() => createMyApiKey(user, parsed.data.name, days));
    revalidatePath("/settings/integrations");
    return { status: "success", message: "Copy this key now. It will not be shown again.", key, ts: Date.now() };
  } catch (err) {
    if (err instanceof IntegrationError || err instanceof OAuthError) return { status: "error", message: err.message, ts: Date.now() };
    throw err;
  }
}

export async function revokeMyTokenAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = str(fd, "tokenId");
  if (!z.string().uuid().safeParse(id).success) return fail("Unknown key.");
  const done = await audited(() => revokeToken(user, id));
  revalidatePath("/settings/integrations");
  revalidatePath("/admin/integrations");
  return done ? ok("Revoked.") : fail("That key was already revoked.");
}

export async function disconnectAppAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const clientId = str(fd, "clientId");
  if (!clientId || clientId.length > 100) return fail("Unknown app.");
  const n = await audited(() => disconnectApp(user, clientId));
  revalidatePath("/settings/integrations");
  return n ? ok("Disconnected.") : fail("That app was not connected.");
}
