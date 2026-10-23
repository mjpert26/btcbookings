"use client";

import { useState } from "react";
import { ActionForm, useFieldError } from "@/components/ui/Form";
import { controlClass, Fieldset, Input } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/lib/form-state";
import { cn } from "@/lib/cn";

export type SfFormValues = {
  createSfLead: boolean;
  isoAccountId: string;
  campaignId: string;
  ownerMode: "assigned_host" | "fixed" | "assignment_rules";
  ownerFixedId: string;
  fieldMapping: { source: string; field: string }[];
  staticValues: { key: string; value: string }[];
  createTask: boolean;
  createNote: boolean;
  setMeetingBookedFields: boolean;
};

type Source = { value: string; label: string };

function RowError({ name }: { name: string }) {
  const err = useFieldError(name);
  return err ? <p className="text-xs font-medium text-danger">{err}</p> : null;
}

function MappingEditor({ initial, sources }: { initial: SfFormValues["fieldMapping"]; sources: Source[] }) {
  const [rows, setRows] = useState(initial);
  return (
    <div className="space-y-2">
      <input type="hidden" name="fieldMapping" value={JSON.stringify(rows)} />
      {rows.length === 0 ? <p className="text-sm text-muted">No fields mapped.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-start">
          <div>
            <label htmlFor={`map-src-${i}`} className="sr-only">
              Source for mapping {i + 1}
            </label>
            <select
              id={`map-src-${i}`}
              value={r.source}
              onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, source: e.target.value } : x)))}
              className={controlClass}
            >
              <option value="">Choose a source…</option>
              <optgroup label="Booking data">
                {sources
                  .filter((s) => !s.value.startsWith("q:"))
                  .map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
              </optgroup>
              {sources.some((s) => s.value.startsWith("q:")) ? (
                <optgroup label="Booking questions">
                  {sources
                    .filter((s) => s.value.startsWith("q:"))
                    .map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
            <RowError name={`fieldMapping.${i}.source`} />
          </div>
          <span aria-hidden="true" className="hidden pt-2 text-muted sm:block">
            →
          </span>
          <div>
            <label htmlFor={`map-field-${i}`} className="sr-only">
              Lead field API name for mapping {i + 1}
            </label>
            <input
              id={`map-field-${i}`}
              value={r.field}
              placeholder="Lead field, e.g. Company"
              spellCheck={false}
              onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, field: e.target.value } : x)))}
              className={cn(controlClass, "font-mono")}
            />
            <RowError name={`fieldMapping.${i}.field`} />
          </div>
          <button type="button" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="h-10 rounded-md px-2 text-sm text-danger hover:bg-danger/5">
            Remove<span className="sr-only"> mapping {i + 1}</span>
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { source: "", field: "" }])} className="rounded-md px-2 py-1 text-sm font-semibold text-primary hover:bg-primary/10">
        + Add mapping
      </button>
    </div>
  );
}

function StaticEditor({ initial }: { initial: SfFormValues["staticValues"] }) {
  const [rows, setRows] = useState(initial);
  return (
    <div className="space-y-2">
      <input type="hidden" name="staticValues" value={JSON.stringify(rows)} />
      {rows.length === 0 ? <p className="text-sm text-muted">No static values.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
          <div>
            <label htmlFor={`st-key-${i}`} className="sr-only">
              Lead field for static value {i + 1}
            </label>
            <input id={`st-key-${i}`} value={r.key} placeholder="Lead field, e.g. Status" spellCheck={false} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, key: e.target.value } : x)))} className={cn(controlClass, "font-mono")} />
            <RowError name={`staticValues.${i}.key`} />
          </div>
          <div>
            <label htmlFor={`st-val-${i}`} className="sr-only">
              Value for static value {i + 1}
            </label>
            <input id={`st-val-${i}`} value={r.value} placeholder="Value" onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))} className={controlClass} />
            <RowError name={`staticValues.${i}.value`} />
          </div>
          <button type="button" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="h-10 rounded-md px-2 text-sm text-danger hover:bg-danger/5">
            Remove<span className="sr-only"> static value {i + 1}</span>
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { key: "", value: "" }])} className="rounded-md px-2 py-1 text-sm font-semibold text-primary hover:bg-primary/10">
        + Add static value
      </button>
    </div>
  );
}

export function SfSettingsForm({ action, values, sources, readOnly = false }: { action: FormAction; values: SfFormValues; sources: Source[]; readOnly?: boolean }) {
  const [enabled, setEnabled] = useState(values.createSfLead);
  const [ownerMode, setOwnerMode] = useState(values.ownerMode);
  return (
    <ActionForm action={action} className="space-y-6" aria-label="Salesforce lead settings">
      <fieldset disabled={readOnly} className="space-y-6">
        <legend className="sr-only">Salesforce lead settings</legend>
        <div className={cn("rounded-brand border-2 p-5", enabled ? "border-primary bg-primary/5" : "border-border bg-surface-alt")}>
          <Switch
            name="createSfLead"
            size="lg"
            label="Create a Salesforce Lead for every booking"
            description={enabled ? "On: each confirmed booking sends a Lead to Salesforce through n8n." : "Off: bookings do not create Leads."}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={readOnly}
          />
        </div>

        <Input
          label="Lead source (ISO)"
          name="isoAccountId"
          defaultValue={values.isoAccountId}
          placeholder="0015e00000AbCdEAAV"
          spellCheck={false}
          hint="Salesforce Account Id of the ISO partner that sent the lead. Saved as csbs__ISO__c. This is not the standard LeadSource picklist; set that with a static value if needed."
          wrapperClassName="max-w-lg"
        />

        <Fieldset legend="Field mapping" description="Copy booking data into Lead fields. Use the Lead field API name." errorKey="fieldMapping">
          <MappingEditor initial={values.fieldMapping} sources={sources} />
        </Fieldset>

        <Fieldset legend="Static values" description="Fixed values set on every Lead, for example Status = Open." errorKey="staticValues">
          <StaticEditor initial={values.staticValues} />
        </Fieldset>

        <Input label="Campaign ID (optional)" name="campaignId" defaultValue={values.campaignId} placeholder="7015e000000AbCdAAK" spellCheck={false} wrapperClassName="max-w-lg" />

        <Fieldset legend="Lead owner" errorKey="ownerMode">
          <div className="space-y-2">
            {(
              [
                { value: "assigned_host", label: "Assigned host", hint: "The booking's host becomes the Lead owner." },
                { value: "fixed", label: "A fixed User or Queue", hint: "Every Lead goes to the same owner." },
                { value: "assignment_rules", label: "Let Salesforce assignment rules decide", hint: "Salesforce runs its Lead assignment rules." },
              ] as const
            ).map((o) => (
              <label key={o.value} className="flex items-start gap-2.5 text-sm">
                <input type="radio" name="ownerMode" value={o.value} checked={ownerMode === o.value} onChange={() => setOwnerMode(o.value)} className="mt-0.5 size-4 accent-primary" />
                <span>
                  <span className="font-medium text-ink">{o.label}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {ownerMode === "fixed" ? (
            <Input label="Owner ID" name="ownerFixedId" defaultValue={values.ownerFixedId} required placeholder="005... or 00G..." spellCheck={false} wrapperClassName="max-w-lg" />
          ) : null}
          <p className="rounded-md bg-surface-alt px-3 py-2 text-xs text-muted">
            &ldquo;Let Salesforce assignment rules decide&rdquo; sends the header <code className="font-mono">Sforce-Auto-Assign: TRUE</code>. The other options send{" "}
            <code className="font-mono">Sforce-Auto-Assign: FALSE</code> so the owner set here is kept.
          </p>
        </Fieldset>

        <Fieldset
          legend="Follow-up in Salesforce"
          description="Optional steps n8n runs after a new Lead is created. They follow the conventions of the existing Meeting Booked writer. All are off by default."
        >
          <div className="space-y-4">
            <Switch
              name="setMeetingBookedFields"
              label="Set Meeting Booked fields"
              description="Status Working - Contacted, Status Detail Meeting Booked, Meeting Booked and the meeting time are set on the new Lead."
              defaultChecked={values.setMeetingBookedFields}
              disabled={readOnly}
            />
            <Switch
              name="createTask"
              label="Create a Meeting Booked Task"
              description="A Task on the Lead with the meeting start time."
              defaultChecked={values.createTask}
              disabled={readOnly}
            />
            <Switch
              name="createNote"
              label="Create a Meeting Booked note"
              description='A note on the Lead with the time, host and source "BTC Scheduler - event type".'
              defaultChecked={values.createNote}
              disabled={readOnly}
            />
          </div>
        </Fieldset>
      </fieldset>

      {!readOnly ? <SubmitButton>Save Salesforce settings</SubmitButton> : null}
    </ActionForm>
  );
}
