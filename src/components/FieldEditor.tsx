"use client";

import { useActionState } from "react";
import { editEntryFieldAction, type ActionState } from "@/app/actions";

/** Edit one agent-written value in review. The server re-checks the field's rules. */
export function FieldEditor({ postId, field, label, value, seen, max }: { postId: number; field: string; label: string; value: string; seen: string; max?: number }) {
  const [state, run, busy] = useActionState<ActionState, FormData>(editEntryFieldAction, { status: "idle" });
  const id = `edit-${postId}-${field}`;
  const msg = `${id}-msg`;
  return (
    <form action={run} className="fieldedit">
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="seen" value={seen} />
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea id={id} name="value" className="textarea" defaultValue={value} rows={3} aria-invalid={state.status === "error"} aria-describedby={msg} />
      <div className="fieldedit__bar">
        <button type="submit" className="btn btn--quiet" disabled={busy}>
          {busy ? "Saving…" : "Save edit"}
        </button>
        <span className="muted mono">{value.length}{max ? ` / ${max}` : ""} chars</span>
        <span id={msg} className={`action__msg${state.status === "error" ? " action__msg--error" : ""}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite">
          {state.status === "idle" ? "" : state.message}
        </span>
      </div>
    </form>
  );
}
