"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentEvent } from "@/core/agent";

type State = { status: "idle" } | { status: "running"; events: AgentEvent[] } | { status: "done"; events: AgentEvent[] } | { status: "error"; events: AgentEvent[]; message: string };

const usd = (m: number) => `$${(m / 1e6).toFixed(3)}`;

/**
 * Starts a run and reads the NDJSON stream line by line, so each tool call
 * shows as it happens. `initial` replays the last stored run's events.
 */
export function AgentRunner({ postId, ready, readyReason, initial, live }: { postId: number; ready: boolean; readyReason: string; initial: AgentEvent[]; live: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>(initial.length ? { status: "done", events: initial } : { status: "idle" });
  const events = state.status === "idle" ? [] : state.events;

  async function start() {
    const seen: AgentEvent[] = [];
    setState({ status: "running", events: [] });
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postId }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.message ?? `The server answered ${res.status}.`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          seen.push(JSON.parse(line) as AgentEvent);
          setState({ status: "running", events: [...seen] });
        }
      }
      const failed = seen.find((e) => e.type === "error");
      setState(failed && failed.type === "error" ? { status: "error", events: seen, message: failed.message } : { status: "done", events: seen });
      router.refresh();
    } catch (e) {
      setState({ status: "error", events: seen, message: e instanceof Error ? e.message : "The run failed." });
    }
  }

  const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
  return (
    <div className="runner">
      <div className="runner__bar">
        <button type="button" className="btn" onClick={start} disabled={!ready || state.status === "running"}>
          {state.status === "running" ? "Agent working…" : events.length ? "Run again" : live ? "Run the agent" : "Replay the agent's run"}
        </button>
        {!ready && <span className="action__msg">{readyReason}</span>}
        {done && (
          <span className={`stamp ${done.status === "submitted" ? "stamp--ok" : "stamp--held"}`}>
            {done.status} · {done.turns} turns · {usd(done.costMicros)}
          </span>
        )}
      </div>
      <ol className="trace" aria-live="polite" aria-label="Agent trace">
        {events.map((e, i) => (
          <TraceLine key={i} e={e} />
        ))}
        {state.status === "running" && <li className="trace__wait">waiting for the model…</li>}
      </ol>
      {state.status === "error" && (
        <p className="action__msg action__msg--error" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}

function TraceLine({ e }: { e: AgentEvent }) {
  switch (e.type) {
    case "start":
      return <li className="trace__meta">run #{e.runId} · {e.mode === "live" ? "live" : "replaying a recorded run"}</li>;
    case "turn":
      return (
        <li className="trace__meta">
          turn {e.n} · {(e.inputTokens + e.cacheReadTokens + (e.cacheWriteTokens ?? 0)).toLocaleString("en")} in
          {e.cacheReadTokens ? ` (${e.cacheReadTokens.toLocaleString("en")} from cache)` : ""}
          {e.cacheWriteTokens ? ` (${e.cacheWriteTokens.toLocaleString("en")} cached for next turns)` : ""} / {e.outputTokens} out · {usd(e.costMicros)}
        </li>
      );
    case "note":
      return <li className="trace__note">{e.text}</li>;
    case "tool":
      return (
        <li className={`trace__tool${e.ok ? "" : " trace__tool--bad"}`}>
          <span className="mono">{e.name}</span> <span>{e.summary}</span>
          {!e.ok && <span className="sr-only"> (rejected)</span>}
        </li>
      );
    case "done":
      return <li className="trace__done">{e.reason}</li>;
    case "error":
      return <li className="trace__tool trace__tool--bad">{e.message}</li>;
  }
}
