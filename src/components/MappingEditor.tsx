"use client";

import { useActionState, useState } from "react";
import { checkMapping, SOURCE_FIELDS, TRANSFORM_IDS, TRANSFORMS, targetShape, type FieldMapping, type Mapping, type SourceFieldId, type TransformId } from "@/core/mapping";
import type { ContentType } from "@/core/model";
import { saveMappingAction, type ActionState } from "@/app/actions";

type Props = { contentType: ContentType; initial: Mapping };

/**
 * The review step. Every target field is a row: what Claude chose, its
 * confidence and note, and controls to change it. The same check the server
 * runs (`checkMapping`, pure core code) runs here on every change, so
 * problems show before saving.
 */
export function MappingEditor({ contentType: ct, initial }: Props) {
  const [mapping, setMapping] = useState<Mapping>(initial);
  const [state, save, busy] = useActionState<ActionState, FormData>(saveMappingAction, { status: "idle" });
  const problems = checkMapping(mapping, ct);
  const dirty = JSON.stringify(mapping) !== JSON.stringify(initial);

  const rowFor = (target: string): FieldMapping =>
    mapping.fields.find((f) => f.target === target) ?? { target, sources: [], transform: "none", fallback: null, confidence: "low", note: "" };

  const update = (target: string, change: Partial<FieldMapping>) =>
    setMapping((m) => {
      const exists = m.fields.some((f) => f.target === target);
      const fields = exists ? m.fields.map((f) => (f.target === target ? { ...f, ...change } : f)) : [...m.fields, { ...rowFor(target), ...change }];
      return { ...m, fields };
    });

  return (
    <form action={save} className="mapper">
      <input type="hidden" name="contentType" value={ct.sys.id} />
      <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
      <div className="mapper__rows">
        {ct.fields.map((field) => {
          const row = rowFor(field.id);
          const rowProblems = problems.filter((p) => p.target === field.id);
          const shape = targetShape(field);
          const idBase = `map-${field.id}`;
          return (
            <fieldset key={field.id} className={`maprow${rowProblems.some((p) => p.severity === "error") ? " maprow--error" : ""}`} aria-describedby={rowProblems.length ? `${idBase}-problems` : undefined}>
              <legend className="maprow__target">
                <span className="maprow__name">{field.name}</span>
                <span className="mono muted">
                  {field.id} · {shape}
                  {field.required ? " · required" : ""}
                </span>
              </legend>
              <Step
                idBase={idBase}
                label="Fill from"
                shapeOk={(t) => Boolean(shape && (TRANSFORMS[t].fills as readonly string[]).includes(shape))}
                transform={row.transform}
                sources={row.sources}
                onChange={(transform, sources) => update(field.id, { transform, sources })}
              />
              {row.fallback ? (
                <div className="maprow__fallback">
                  <Step
                    idBase={`${idBase}-fb`}
                    label="If empty or invalid"
                    shapeOk={(t) => t !== "none" && Boolean(shape && (TRANSFORMS[t].fills as readonly string[]).includes(shape))}
                    transform={row.fallback.transform}
                    sources={row.fallback.sources}
                    onChange={(transform, sources) => update(field.id, { fallback: { transform, sources } })}
                  />
                  <button type="button" className="linkbtn" onClick={() => update(field.id, { fallback: null })}>
                    Remove fallback
                  </button>
                </div>
              ) : (
                row.transform !== "none" && (
                  <button type="button" className="linkbtn" onClick={() => update(field.id, { fallback: { transform: "generate", sources: ["post.title", "post.content"] } })}>
                    Add a fallback
                  </button>
                )
              )}
              <p className="maprow__meta">
                <span className={`conf conf--${row.confidence}`}>{row.confidence} confidence</span>
                {row.note && <span>{row.note}</span>}
              </p>
              {rowProblems.length > 0 && (
                <ul id={`${idBase}-problems`} className="maprow__problems">
                  {rowProblems.map((p) => (
                    <li key={p.message} className={p.severity === "error" ? "is-error" : "is-warning"}>
                      <span className="sr-only">{p.severity}: </span>
                      {p.message}
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="mapper__bar">
        <button type="submit" className="btn" disabled={busy || !dirty}>
          {busy ? "Saving…" : dirty ? "Save changes" : "No changes"}
        </button>
        <span className="muted">
          {problems.filter((p) => p.severity === "error").length} errors · {problems.filter((p) => p.severity === "warning").length} warnings
        </span>
        <p className={`action__msg${state.status === "error" ? " action__msg--error" : ""}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite">
          {state.status === "idle" ? "" : state.message}
        </p>
      </div>
    </form>
  );
}

function Step({
  idBase,
  label,
  transform,
  sources,
  shapeOk,
  onChange,
}: {
  idBase: string;
  label: string;
  transform: TransformId;
  sources: SourceFieldId[];
  shapeOk: (t: TransformId) => boolean;
  onChange: (t: TransformId, s: SourceFieldId[]) => void;
}) {
  const accepts = TRANSFORMS[transform].accepts as readonly string[];
  const usable = SOURCE_FIELDS.filter((f) => accepts.includes(f.kind));
  return (
    <div className="step">
      <label className="step__field" htmlFor={`${idBase}-t`}>
        <span className="step__label">{label}</span>
        <select
          id={`${idBase}-t`}
          className="select"
          value={transform}
          onChange={(e) => {
            const t = e.target.value as TransformId;
            const keep = sources.filter((s) => (TRANSFORMS[t].accepts as readonly string[]).includes(SOURCE_FIELDS.find((f) => f.id === s)?.kind ?? ""));
            onChange(t, t === "none" ? [] : keep);
          }}
        >
          {TRANSFORM_IDS.map((t) => (
            <option key={t} value={t} disabled={!shapeOk(t) && t !== transform}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {transform !== "none" && (
        <fieldset className="step__sources">
          <legend className="sr-only">Source fields for {label.toLowerCase()}</legend>
          {usable.map((f) => {
            const on = sources.includes(f.id);
            return (
              <label key={f.id} className={`pick${on ? " pick--on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => onChange(transform, on ? sources.filter((s) => s !== f.id) : [...sources, f.id])} />
                <span className="mono">{f.id.replace("post.", "")}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      <p className="step__what muted">{TRANSFORMS[transform].what}</p>
    </div>
  );
}
