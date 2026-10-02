"use client";

import { useState } from "react";
import { QUESTION_TYPES, type QuestionInput } from "@/lib/event-types";
import { controlClass } from "@/components/ui/Field";
import { useFieldError } from "@/components/ui/Form";
import { cn } from "@/lib/cn";

type Q = {
  key: string;
  type: QuestionInput["type"];
  label: { en: string; es: string };
  required: boolean;
  options: { value: string; label: { en: string; es: string } }[];
};

let uid = 0;
type Keyed<T> = T & { _id: number };

function slugKey(label: string): string {
  const k = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(k) ? k : `q_${k}`.replace(/_+$/, "");
}

function TextField({ id, label, value, onChange, error, placeholder, className }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; placeholder?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-xs font-medium text-navy">
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        className={controlClass}
      />
      {error ? (
        <p id={`${id}-err`} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function QuestionCard({
  q,
  index,
  count,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  q: Keyed<Q>;
  index: number;
  count: number;
  disabled: boolean;
  onChange: (q: Keyed<Q>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const base = `q-${q._id}`;
  const keyErr = useFieldError(`questions.${index}.key`);
  const labelErr = useFieldError(`questions.${index}.label`);
  const optErr = useFieldError(`questions.${index}.options`);
  const title = q.label.en || q.label.es || `Question ${index + 1}`;
  return (
    <li className="rounded-lg border border-border bg-surface p-4">
      <fieldset disabled={disabled} className="space-y-3">
        <legend className="sr-only">{title}</legend>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold text-navy">
            {index + 1}. {title}
          </p>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => onMove(-1)} disabled={index === 0} className="rounded-md px-2 py-1 text-sm text-primary hover:bg-primary/10 disabled:opacity-40">
              Move up<span className="sr-only">: {title}</span>
            </button>
            <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} className="rounded-md px-2 py-1 text-sm text-primary hover:bg-primary/10 disabled:opacity-40">
              Move down<span className="sr-only">: {title}</span>
            </button>
            <button type="button" onClick={onRemove} className="rounded-md px-2 py-1 text-sm text-danger hover:bg-danger/5">
              Remove<span className="sr-only">: {title}</span>
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            id={`${base}-en`}
            label="Label (English)"
            value={q.label.en}
            error={labelErr}
            onChange={(v) => onChange({ ...q, label: { ...q.label, en: v }, key: q.key || !v ? q.key : slugKey(v) })}
          />
          <TextField id={`${base}-es`} label="Label (Spanish)" value={q.label.es} onChange={(v) => onChange({ ...q, label: { ...q.label, es: v } })} />
          <TextField
            id={`${base}-key`}
            label="Key (used in Salesforce mapping)"
            value={q.key}
            error={keyErr}
            placeholder="company_name"
            onChange={(v) => onChange({ ...q, key: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={`${base}-type`} className="text-xs font-medium text-navy">
              Type
            </label>
            <select id={`${base}-type`} value={q.type} onChange={(e) => onChange({ ...q, type: e.target.value as Q["type"] })} className={controlClass}>
              {QUESTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={q.required} onChange={(e) => onChange({ ...q, required: e.target.checked })} className="size-4 accent-primary" />
          Required
        </label>
        {q.type === "dropdown" ? (
          <div className="rounded-md bg-surface-alt p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Options</p>
            <ul className="space-y-2">
              {q.options.map((o, oi) => (
                <li key={oi} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <TextField
                    id={`${base}-o${oi}-v`}
                    label="Value"
                    value={o.value}
                    onChange={(v) => onChange({ ...q, options: q.options.map((x, k) => (k === oi ? { ...x, value: v } : x)) })}
                  />
                  <TextField
                    id={`${base}-o${oi}-en`}
                    label="Label (English)"
                    value={o.label.en}
                    onChange={(v) =>
                      onChange({ ...q, options: q.options.map((x, k) => (k === oi ? { ...x, label: { ...x.label, en: v }, value: x.value || slugKey(v) } : x)) })
                    }
                  />
                  <TextField
                    id={`${base}-o${oi}-es`}
                    label="Label (Spanish)"
                    value={o.label.es}
                    onChange={(v) => onChange({ ...q, options: q.options.map((x, k) => (k === oi ? { ...x, label: { ...x.label, es: v } } : x)) })}
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ ...q, options: q.options.filter((_, k) => k !== oi) })}
                    className="h-10 rounded-md px-2 text-sm text-danger hover:bg-danger/5"
                  >
                    Remove<span className="sr-only"> option {oi + 1}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => onChange({ ...q, options: [...q.options, { value: "", label: { en: "", es: "" } }] })}
              className="mt-2 rounded-md px-2 py-1 text-sm font-semibold text-primary hover:bg-primary/10"
            >
              + Add option
            </button>
            {optErr ? <p className="mt-1 text-xs font-medium text-danger">{optErr}</p> : null}
          </div>
        ) : null}
      </fieldset>
    </li>
  );
}

/** Booking form question editor. Serializes to the hidden "questions" field as JSON. */
export function QuestionsEditor({ initial, disabled = false }: { initial: Q[]; disabled?: boolean }) {
  const [items, setItems] = useState<Keyed<Q>[]>(() => initial.map((q) => ({ ...q, _id: ++uid })));
  const listErr = useFieldError("questions");

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  }

  const payload = items.map((q) => ({ key: q.key, type: q.type, label: q.label, required: q.required, options: q.options }));
  return (
    <div className="space-y-3">
      {!disabled ? <input type="hidden" name="questions" value={JSON.stringify(payload)} /> : null}
      <p className="text-sm text-muted">Name and email are always collected. Add any extra questions here.</p>
      {items.length ? (
        <ol className="space-y-3">
          {items.map((q, i) => (
            <QuestionCard
              key={q._id}
              q={q}
              index={i}
              count={items.length}
              disabled={disabled}
              onChange={(nq) => setItems(items.map((x) => (x._id === q._id ? nq : x)))}
              onRemove={() => setItems(items.filter((x) => x._id !== q._id))}
              onMove={(d) => move(i, d)}
            />
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No extra questions.</p>
      )}
      {listErr ? <p className="text-sm font-medium text-danger">{listErr}</p> : null}
      {!disabled ? (
        <button
          type="button"
          onClick={() => setItems([...items, { _id: ++uid, key: "", type: "text", label: { en: "", es: "" }, required: false, options: [] }])}
          className="rounded-md border border-dashed border-primary/50 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5"
        >
          + Add question
        </button>
      ) : null}
    </div>
  );
}

export type { Q as EditorQuestion };
