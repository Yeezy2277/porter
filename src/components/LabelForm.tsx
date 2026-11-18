"use client";

import { useActionState } from "react";
import { saveLabelAction, type ActionState } from "@/app/actions";

type Props = { id: string; criteria: { id: string; text: string }[]; saved: Record<string, boolean> | null };

/** One item's labels: an explicit pass/fail per criterion, no default, so nothing is labelled by accident. */
export function LabelForm({ id, criteria, saved }: Props) {
  const [state, run, busy] = useActionState<ActionState, FormData>(saveLabelAction, { status: "idle" });
  return (
    <form action={run} className="labelform">
      <input type="hidden" name="id" value={id} />
      {criteria.map((c) => (
        <fieldset key={c.id} className="labelform__row">
          <legend>
            <strong>{c.id}</strong> <span className="muted">{c.text}</span>
          </legend>
          {(["pass", "fail"] as const).map((v) => (
            <label key={v} className="pick">
              <input type="radio" name={c.id} value={v} required defaultChecked={saved ? saved[c.id] === (v === "pass") : false} />
              <span>{v}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="fieldedit__bar">
        <button type="submit" className="btn btn--quiet" disabled={busy}>
          {busy ? "Saving…" : saved ? "Update labels" : "Save labels"}
        </button>
        <span className={`action__msg${state.status === "error" ? " action__msg--error" : ""}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite">
          {state.status === "idle" ? (saved ? "Labelled" : "") : state.message}
        </span>
      </div>
    </form>
  );
}
