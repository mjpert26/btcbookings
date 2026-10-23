"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ui/Form";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/lib/form-state";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function CreateTeamForm({ action, baseUrl }: { action: FormAction; baseUrl: string }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const shownSlug = slugEdited ? slug : slugify(name);

  return (
    <ActionForm action={action} className="space-y-5" aria-label="Create a team">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Input label="Team name" name="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Funding Advisors" autoComplete="off" />
        <Input
          label="URL slug"
          name="slug"
          required
          maxLength={64}
          value={shownSlug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
          placeholder="funding-advisors"
          hint={`Team booking pages live at ${baseUrl}/t/${shownSlug || "slug"}/…`}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <Textarea label="Description (optional)" name="description" rows={3} maxLength={1000} hint="Shown to employees on the team page." />
      <Select
        label="Membership source"
        name="membershipSource"
        defaultValue="manual"
        options={[
          { value: "manual", label: "Manual: team admins manage the roster" },
          { value: "salesforce_queue", label: "Salesforce Queue: the roster mirrors linked queues" },
          { value: "queue_plus_manual", label: "Queue plus manual: queue members and manually added members" },
        ]}
        hint="Queue-driven teams are linked to their Salesforce Queues on the next page."
      />
      <SubmitButton pendingLabel="Creating…">Create team</SubmitButton>
    </ActionForm>
  );
}
