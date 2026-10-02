"use client";

import { startTransition, useActionState, useOptimistic } from "react";
import { Switch } from "@/components/ui/Switch";
import { InlineStatus } from "@/components/ui/Toast";
import { IDLE, type FormAction } from "@/lib/form-state";

/** Switch that overrides (on) or inherits (off) one settings group on a variant. Saves on change. */
export function GroupToggle({ action, group, label, overridden, disabled }: { action: FormAction; group: string; label: string; overridden: boolean; disabled?: boolean }) {
  const [state, run, pending] = useActionState(action, IDLE);
  const [optimistic, setOptimistic] = useOptimistic(overridden);

  function onChange(next: boolean) {
    const fd = new FormData();
    fd.set("group", group);
    fd.set("override", next ? "1" : "0");
    startTransition(() => {
      setOptimistic(next);
      run(fd);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Switch
        label={`Override ${label}`}
        description={optimistic ? "The variant uses its own values." : "The variant uses the parent's values."}
        checked={optimistic}
        onCheckedChange={onChange}
        disabled={disabled || pending}
      />
      <InlineStatus state={state} />
    </div>
  );
}
