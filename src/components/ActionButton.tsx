"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/actions";

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  label: string;
  pending: string;
  hidden?: Record<string, string>;
  className?: string;
  disabled?: boolean;
  disabledReason?: string;
};

/** A one-button form with its own pending state and an announced result. */
export function ActionButton({ action, label, pending, hidden = {}, className = "btn", disabled, disabledReason }: Props) {
  const [state, run, busy] = useActionState(action, { status: "idle" });
  return (
    <form action={run} className="action">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className={className} disabled={busy || disabled} title={disabled ? disabledReason : undefined}>
        {busy ? pending : label}
      </button>
      <p className={`action__msg${state.status === "error" ? " action__msg--error" : ""}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite">
        {state.status === "idle" ? (disabled && disabledReason ? disabledReason : "") : state.message}
      </p>
    </form>
  );
}
