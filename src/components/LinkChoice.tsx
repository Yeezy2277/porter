"use client";

import { useActionState } from "react";
import { overrideLinkAction, type ActionState } from "@/app/actions";

type Option = { value: string; label: string };

/** A reviewer's override for one item: a select of the allowed choices, saved on change. */
export function LinkChoice({ source, label, current, options }: { source: string; label: string; current: string; options: Option[] }) {
  const [state, run, busy] = useActionState<ActionState, FormData>(overrideLinkAction, { status: "idle" });
  const id = `choice-${source.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <form action={run} className="choice">
      <input type="hidden" name="source" value={source} />
      <label htmlFor={id} className="sr-only">
        Decision for {label}
      </label>
      <select
        id={id}
        name="choice"
        className="select"
        defaultValue={current}
        disabled={busy}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className={`action__msg${state.status === "error" ? " action__msg--error" : ""}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite">
        {busy ? "Saving…" : state.status === "error" ? state.message : ""}
      </span>
    </form>
  );
}
