"use client";

import { startTransition, useActionState, useOptimistic } from "react";
import { ActionForm } from "@/components/ui/Form";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Switch } from "@/components/ui/Switch";
import { Dialog, DialogCloseButton } from "@/components/ui/Dialog";
import { InlineStatus } from "@/components/ui/Toast";
import { IDLE, type FormAction } from "@/lib/form-state";

const MODE_OPTIONS = [
  { value: "add_only", label: "Add only: invite active members" },
  { value: "add_and_remove", label: "Add and remove: also remove paused members" },
];

type ChannelValues = { mode: string; protectedSlackUserIds: string; notifyChannelId: string };

function ChannelFields({ values, includeId }: { values: ChannelValues; includeId: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {includeId ? (
        <Input
          label="Channel ID"
          name="channelId"
          required
          placeholder="C012ABCDEF"
          hint="In Slack: channel details, then copy the ID at the bottom. The name and health are read from Slack."
          autoComplete="off"
          spellCheck={false}
          wrapperClassName="md:col-span-2"
        />
      ) : null}
      <Select label="Mode" name="mode" defaultValue={values.mode} options={MODE_OPTIONS} />
      <Input label="Notify channel ID (optional)" name="notifyChannelId" defaultValue={values.notifyChannelId} placeholder="C0NOTIFY01" hint="Where the bot posts a note about each change." spellCheck={false} />
      <Textarea
        label="Protected Slack user IDs"
        name="protectedSlackUserIds"
        defaultValue={values.protectedSlackUserIds}
        rows={2}
        hint="Never removed by sync. Separate with commas or spaces, e.g. U012ABCDEF."
        wrapperClassName="md:col-span-2"
        spellCheck={false}
      />
    </div>
  );
}

export function AddChannelForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} className="space-y-4" aria-label="Add a Slack channel">
      <ChannelFields values={{ mode: "add_only", protectedSlackUserIds: "", notifyChannelId: "" }} includeId />
      <p className="text-sm text-muted">New channels start in dry-run mode.</p>
      <SubmitButton pendingLabel="Adding…">Add channel</SubmitButton>
    </ActionForm>
  );
}

export function EditChannelDialog({ action, values, label }: { action: FormAction; values: ChannelValues; label: string }) {
  return (
    <Dialog trigger={<>Edit<span className="sr-only"> {label}</span></>} triggerSize="sm" title={`Edit ${label}`} className="w-[min(44rem,calc(100vw-2rem))]">
      <ActionForm action={action} className="space-y-4">
        <ChannelFields values={values} includeId={false} />
        <div className="flex justify-end gap-2">
          <DialogCloseButton>Close</DialogCloseButton>
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </Dialog>
  );
}

/** Dry-run switch that saves immediately. */
export function DryRunToggle({ action, dryRun, label }: { action: FormAction; dryRun: boolean; label: string }) {
  const [state, run, pending] = useActionState(action, IDLE);
  const [value, setValue] = useOptimistic(dryRun);
  return (
    <div className="space-y-1">
      <Switch
        label={`Dry run for ${label}`}
        description={value ? "Changes are recorded but not applied." : "Live: changes apply to the channel."}
        checked={value}
        disabled={pending}
        onCheckedChange={(next) => {
          const fd = new FormData();
          fd.set("dryRun", next ? "on" : "off");
          startTransition(() => {
            setValue(next);
            run(fd);
          });
        }}
      />
      <InlineStatus state={state} />
    </div>
  );
}
