"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { createWebhook, deleteWebhook, rotateWebhookSecret, sendTestWebhook, setWebhookEnabled, WebhookError } from "@/server/webhooks/admin";
import type { ActionState } from "@/lib/form-state";
import { fail, ok, str } from "@/server/ui/form";
import { audited } from "@/server/ui/admin";

export type SecretState = { status: "idle" | "success" | "error"; message?: string; secret?: string; ts?: number };

const PATH = "/admin/webhooks";
const idSchema = z.uuid();

function errorMessage(err: unknown): string | null {
  if (err instanceof WebhookError) return err.message;
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid request.";
  return null;
}

async function run(fn: () => Promise<string>): Promise<ActionState> {
  try {
    const message = await audited(fn);
    revalidatePath(PATH);
    return ok(message);
  } catch (err) {
    const m = errorMessage(err);
    if (m) return fail(m);
    throw err;
  }
}

export async function createWebhookAction(_prev: SecretState, fd: FormData): Promise<SecretState> {
  const user = await requireAdmin();
  try {
    const { secret } = await audited(() =>
      createWebhook(user, {
        url: str(fd, "url"),
        description: str(fd, "description"),
        events: fd.getAll("events").map(String) as never,
        teamId: str(fd, "teamId") || null,
      }),
    );
    revalidatePath(PATH);
    return { status: "success", message: "Webhook added. Copy the signing secret now. It will not be shown again.", secret, ts: Date.now() };
  } catch (err) {
    const m = errorMessage(err);
    if (m) return { status: "error", message: m, ts: Date.now() };
    throw err;
  }
}

export async function rotateWebhookSecretAction(_prev: SecretState, fd: FormData): Promise<SecretState> {
  const user = await requireAdmin();
  const id = str(fd, "id");
  if (!idSchema.safeParse(id).success) return { status: "error", message: "Unknown webhook.", ts: Date.now() };
  try {
    const { secret } = await audited(() => rotateWebhookSecret(user, id));
    revalidatePath(PATH);
    return { status: "success", message: "New signing secret. Update the receiver; the old secret no longer signs deliveries.", secret, ts: Date.now() };
  } catch (err) {
    const m = errorMessage(err);
    if (m) return { status: "error", message: m, ts: Date.now() };
    throw err;
  }
}

export async function toggleWebhookAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const id = str(fd, "id");
  if (!idSchema.safeParse(id).success) return fail("Unknown webhook.");
  const enable = str(fd, "enable") === "1";
  return run(async () => {
    await setWebhookEnabled(user, id, enable);
    return enable ? "Webhook enabled." : "Webhook disabled. Pending deliveries will not be sent.";
  });
}

export async function testWebhookAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const id = str(fd, "id");
  if (!idSchema.safeParse(id).success) return fail("Unknown webhook.");
  return run(async () => {
    await sendTestWebhook(user, id);
    return "Test delivery queued. Its result appears under Recent deliveries within a minute.";
  });
}

export async function deleteWebhookAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const id = str(fd, "id");
  if (!idSchema.safeParse(id).success) return fail("Unknown webhook.");
  return run(async () => {
    await deleteWebhook(user, id);
    return "Webhook deleted.";
  });
}
