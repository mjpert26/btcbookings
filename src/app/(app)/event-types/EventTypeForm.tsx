"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ActionForm } from "@/components/ui/Form";
import { Checkbox, Fieldset, Input, Select, Textarea, type SelectOption } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Badge } from "@/components/ui/Badge";
import { DURATION_CHOICES, LOCATION_TYPES, REMINDER_CHOICES, RR_STRATEGIES, type VariantGroupKey } from "@/lib/event-types";
import type { FormAction } from "@/lib/form-state";
import { formatMinutes } from "@/lib/format";
import { QuestionsEditor, type EditorQuestion } from "./QuestionsEditor";
import { HostsEditor, type HostValue, type MemberOption } from "./HostsEditor";

export type EventTypeValues = {
  name: string;
  slug: string;
  descriptionEn: string;
  descriptionEs: string;
  durations: number[];
  defaultDuration: number;
  locationType: string;
  locationDetail: string;
  scheduleId: string;
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  maxPerDay: number | null;
  bookingWindowDays: number;
  slotInterval: number | null;
  reminders: number[];
  isActive: boolean;
  isListed: boolean;
  brandAccent: string;
  questions: EditorQuestion[];
  schedulingMode: "round_robin" | "collective";
  rrStrategy: string;
  rrSticky: boolean;
  hosts: HostValue[];
};

function Section({ title, description, badge, children }: { title: string; description?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-brand border border-border bg-surface p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {badge}
      </div>
      {description ? <p className="-mt-3 mb-4 text-sm text-muted">{description}</p> : null}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function InheritedNote({ variantsHref }: { variantsHref?: string }) {
  return (
    <p className="rounded-md bg-primary/5 px-3 py-2 text-sm text-navy">
      Inherited from the English event type. To change it here,{" "}
      {variantsHref ? (
        <Link href={variantsHref} className="font-semibold text-primary underline">
          override it on the variants page
        </Link>
      ) : (
        "override it on the variants page"
      )}
      .
    </p>
  );
}

/**
 * Disabled controls are not submitted, so inherited groups on a variant post their current
 * values as hidden fields. The server ignores them for inherited groups; they only keep
 * validation of the rest of the form simple.
 */
function InheritedHidden({ group, values }: { group: VariantGroupKey; values: EventTypeValues }) {
  const fields: [string, string | number][] =
    group === "durations"
      ? [...values.durations.map((d) => ["durations", d] as [string, number]), ["defaultDuration", values.defaultDuration]]
      : group === "location"
        ? [["locationType", values.locationType], ["locationDetail", values.locationDetail]]
        : group === "buffers"
          ? [["bufferBefore", values.bufferBefore], ["bufferAfter", values.bufferAfter], ["minNotice", values.minNotice]]
          : group === "branding"
            ? [["descriptionEn", values.descriptionEn], ["descriptionEs", values.descriptionEs], ["brandAccent", values.brandAccent]]
            : [];
  return (
    <>
      {fields.map(([n, v], i) => (
        <input key={`${n}-${i}`} type="hidden" name={n} value={String(v)} />
      ))}
    </>
  );
}

function DurationPicker({ initial, initialDefault, disabled }: { initial: number[]; initialDefault: number; disabled: boolean }) {
  const [selected, setSelected] = useState<number[]>(initial);
  const [def, setDef] = useState(initialDefault);
  const choices = [...new Set([...DURATION_CHOICES, ...initial])].sort((a, b) => a - b);
  const effectiveDefault = selected.includes(def) ? def : (selected[0] ?? def);
  return (
    <>
      <Fieldset legend="Durations" description="Invitees can pick any selected length." errorKey="durations" disabled={disabled}>
        <div className="flex flex-wrap gap-2">
          {choices.map((d) => {
            const on = selected.includes(d);
            return (
              <label key={d} className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border text-ink"}`}>
                <input
                  type="checkbox"
                  name="durations"
                  value={d}
                  checked={on}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, d].sort((a, b) => a - b) : selected.filter((x) => x !== d))}
                  className="size-4 accent-primary"
                />
                {formatMinutes(d)}
              </label>
            );
          })}
        </div>
      </Fieldset>
      <Select
        label="Default duration"
        name="defaultDuration"
        value={String(effectiveDefault)}
        onChange={(e) => setDef(Number(e.target.value))}
        disabled={disabled}
        wrapperClassName="max-w-xs"
        options={selected.map((d) => ({ value: String(d), label: formatMinutes(d) }))}
      />
    </>
  );
}

export function EventTypeForm({
  action,
  values,
  mode,
  ownerOptions,
  defaultOwner = "me",
  members,
  isTeam,
  schedules,
  inherited = [],
  isChild = false,
  variantsHref,
  submitLabel,
}: {
  action: FormAction;
  values: EventTypeValues;
  mode: "create" | "edit";
  ownerOptions?: SelectOption[];
  defaultOwner?: string;
  members?: MemberOption[];
  isTeam: boolean;
  schedules: SelectOption[];
  inherited?: VariantGroupKey[];
  isChild?: boolean;
  variantsHref?: string;
  submitLabel?: string;
}) {
  const [owner, setOwner] = useState(defaultOwner);
  const team = mode === "create" ? owner !== "me" : isTeam;
  const [schedulingMode, setSchedulingMode] = useState(values.schedulingMode);
  const [locationType, setLocationType] = useState(values.locationType);
  const inh = (g: VariantGroupKey) => inherited.includes(g);
  const inhBadge = (g: VariantGroupKey) => (isChild ? inh(g) ? <Badge tone="primary">Inherited</Badge> : <Badge tone="warning">Overridden</Badge> : null);

  return (
    <ActionForm action={action} className="space-y-6" aria-label={mode === "create" ? "Create event type" : "Edit event type"}>
      {isChild ? inherited.map((g) => <InheritedHidden key={g} group={g} values={values} />) : null}
      <Section title="Basics">
        {mode === "create" && ownerOptions && ownerOptions.length > 1 ? (
          <Select
            label="Owner"
            name="owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            options={ownerOptions}
            hint="Team event types are shared by the team's members."
            wrapperClassName="max-w-md"
          />
        ) : mode === "create" ? (
          <input type="hidden" name="owner" value="me" />
        ) : null}
        {mode === "create" ? (
          <Select
            label="Language"
            name="language"
            defaultValue="en"
            options={[
              { value: "en", label: "English" },
              { value: "es", label: "Spanish" },
            ]}
            hint="To offer both languages, create the English page and then add a Spanish variant."
            wrapperClassName="max-w-xs"
          />
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input label="Name" name="name" defaultValue={values.name} required maxLength={120} />
          <Input
            label="URL slug"
            name="slug"
            defaultValue={values.slug}
            required
            maxLength={64}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            disabled={isChild}
            hint={isChild ? "Variants share the English page's slug." : "Lowercase letters, numbers and hyphens."}
          />
        </div>
        {isChild ? <input type="hidden" name="slug" value={values.slug} /> : null}
      </Section>

      <Section title="Description and branding" badge={inhBadge("branding")}>
        {isChild && inh("branding") ? <InheritedNote variantsHref={variantsHref} /> : null}
        <fieldset disabled={isChild && inh("branding")} className="space-y-4">
          <legend className="sr-only">Description and branding</legend>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Textarea label="Description (English)" name="descriptionEn" defaultValue={values.descriptionEn} rows={4} maxLength={2000} />
            <Textarea label="Description (Spanish)" name="descriptionEs" defaultValue={values.descriptionEs} rows={4} maxLength={2000} />
          </div>
          <Input
            label="Accent color"
            name="brandAccent"
            defaultValue={values.brandAccent}
            placeholder="#0D66A5"
            hint="Optional hex color for the booking page. Leave empty for the BTC default."
            wrapperClassName="max-w-xs"
          />
        </fieldset>
      </Section>

      <Section title="Duration" badge={inhBadge("durations")}>
        {isChild && inh("durations") ? <InheritedNote variantsHref={variantsHref} /> : null}
        <DurationPicker initial={values.durations} initialDefault={values.defaultDuration} disabled={isChild && inh("durations")} />
      </Section>

      <Section title="Location" badge={inhBadge("location")}>
        {isChild && inh("location") ? <InheritedNote variantsHref={variantsHref} /> : null}
        <fieldset disabled={isChild && inh("location")} className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <legend className="sr-only">Location</legend>
          <Select label="Location type" name="locationType" value={locationType} onChange={(e) => setLocationType(e.target.value)} options={[...LOCATION_TYPES]} />
          <Input
            label={locationType === "in_person" ? "Address" : locationType === "phone" ? "Phone details (optional)" : locationType === "teams" ? "Notes (optional)" : "Location details"}
            name="locationDetail"
            defaultValue={values.locationDetail}
            maxLength={500}
            required={locationType === "in_person" || locationType === "custom"}
            hint={locationType === "teams" ? "A Teams link is created for every booking." : locationType === "phone" ? "Leave empty to call the invitee's number." : undefined}
          />
        </fieldset>
      </Section>

      <Section title="Availability and limits" badge={isChild ? inhBadge("buffers") : null}>
        <Select label="Schedule" name="scheduleId" defaultValue={values.scheduleId} placeholder={team ? "Each host's default schedule" : "My default schedule"} options={schedules} wrapperClassName="max-w-md" />
        {isChild && inh("buffers") ? <InheritedNote variantsHref={variantsHref} /> : null}
        <fieldset disabled={isChild && inh("buffers")} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <legend className="sr-only">Buffers and notice</legend>
          <Input label="Buffer before (min)" name="bufferBefore" type="number" min={0} max={240} defaultValue={values.bufferBefore} />
          <Input label="Buffer after (min)" name="bufferAfter" type="number" min={0} max={240} defaultValue={values.bufferAfter} />
          <Input label="Minimum notice (min)" name="minNotice" type="number" min={0} defaultValue={values.minNotice} hint="240 = 4 hours" />
        </fieldset>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Booking window (days)" name="bookingWindowDays" type="number" min={1} max={365} defaultValue={values.bookingWindowDays} required />
          <Input label="Max bookings per day" name="maxPerDay" type="number" min={1} max={100} defaultValue={values.maxPerDay ?? ""} hint="Per host. Empty for no limit." />
          <Input label="Slot interval (min)" name="slotInterval" type="number" min={5} max={240} defaultValue={values.slotInterval ?? ""} hint="Empty to use the duration." />
        </div>
      </Section>

      {team ? (
        <Section title="Team routing" description="How bookings are assigned to team members. Routing always belongs to this event type, including variants.">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Select
              label="Scheduling mode"
              name="schedulingMode"
              value={schedulingMode}
              onChange={(e) => setSchedulingMode(e.target.value as "round_robin" | "collective")}
              options={[
                { value: "round_robin", label: "Round-robin (one host per booking)" },
                { value: "collective", label: "Collective (all required hosts attend)" },
              ]}
            />
            {schedulingMode === "round_robin" ? <Select label="Round-robin strategy" name="rrStrategy" defaultValue={values.rrStrategy} options={[...RR_STRATEGIES]} /> : <input type="hidden" name="rrStrategy" value={values.rrStrategy} />}
          </div>
          {schedulingMode === "round_robin" ? (
            <Switch name="rrSticky" label="Returning invitees keep their host" defaultChecked={values.rrSticky} description="When the same email books again, prefer the host they met before." />
          ) : null}
          {mode === "edit" && members ? (
            <Fieldset legend="Host pool" errorKey="hosts">
              <HostsEditor members={members} initial={values.hosts} mode={schedulingMode} />
            </Fieldset>
          ) : (
            <p className="text-sm text-muted">Choose specific hosts after creating the event type. By default every active team member is eligible.</p>
          )}
        </Section>
      ) : null}

      <Section title="Booking form questions" badge={inhBadge("questions")}>
        {isChild && inh("questions") ? <InheritedNote variantsHref={variantsHref} /> : null}
        <QuestionsEditor initial={values.questions} disabled={isChild && inh("questions")} />
      </Section>

      <Section title="Reminders" description="Email reminders sent to the invitee before the meeting.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {REMINDER_CHOICES.map((r) => (
            <Checkbox key={r.value} name="reminders" value={r.value} label={r.label} defaultChecked={values.reminders.includes(r.value)} errorKey="reminders" />
          ))}
        </div>
      </Section>

      <Section title="Visibility">
        <Switch name="isActive" label="Accepting bookings" defaultChecked={values.isActive} description="When off, the booking page shows that it is unavailable." />
        <Switch name="isListed" label="Listed on my public profile" defaultChecked={values.isListed} description="Unlisted pages can still be booked with the direct link." />
      </Section>

      <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-brand sm:border">
        <SubmitButton>{submitLabel ?? (mode === "create" ? "Create event type" : "Save changes")}</SubmitButton>
        <Link href="/event-types" className="text-sm font-medium text-muted hover:text-navy">
          Cancel
        </Link>
      </div>
    </ActionForm>
  );
}
