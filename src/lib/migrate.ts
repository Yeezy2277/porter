import { getDb } from "@/db/client";
import { finishRun, getMapping, saveEntry, startRun } from "@/db/repo";
import { getLinks } from "@/db/search";
import { source } from "@/config/demo";
import { migratable } from "@/core/source";
import type { AgentEvent } from "@/core/agent";
import { runAgent } from "./agent";
import { serverEnv } from "./env";
import { turn, type TurnFn } from "./llm";

export class MigrateError extends Error {}

/**
 * Runs the agent for one post and stores the result. Preconditions are the
 * people's earlier decisions: an approved mapping and approved links.
 */
export async function migratePost(postId: number, emit: (e: AgentEvent) => void, model: TurnFn = turn) {
  const post = source.posts.find((p) => p.id === postId);
  if (!post || !migratable(post).ok) throw new MigrateError("That post isn't in the export, or it isn't published.");
  const db = await getDb();
  const [mapping, links] = await Promise.all([getMapping(db, "article"), getLinks(db)]);
  if (!mapping || mapping.status !== "approved") throw new MigrateError("Approve the field mapping (stage 02) first.");
  if (!links.length || links.some((l) => l.status !== "approved")) throw new MigrateError("Approve the author and topic links (stage 03) first.");

  const mode = serverEnv().live ? "live" : "replay";
  const run = await startRun(db, postId, mode);
  if (!run) throw new MigrateError("A run for this post is already in progress.");
  emit({ type: "start", runId: run.id, postId, mode });
  try {
    const out = await runAgent({ post, mapping: mapping.mapping, links, runId: run.id }, { turn: model, emit });
    const done: AgentEvent = { type: "done", status: out.status, reason: out.reason, entryId: out.draft.id, costMicros: out.usage.costMicros, turns: out.turns };
    emit(done);
    if (out.status === "submitted" || out.status === "flagged") {
      await saveEntry(db, { postId, draft: out.draft, provenance: out.provenance, status: out.status === "submitted" ? "in_review" : "flagged", notes: out.notes, runId: run.id });
    }
    await finishRun(db, run.id, { status: out.status, reason: out.reason, turns: out.turns, ...out.usage, events: [{ type: "start", runId: run.id, postId, mode }, ...out.events, done] });
    return out;
  } catch (e) {
    const message = e instanceof Error ? e.message : "The run failed.";
    emit({ type: "error", message });
    await finishRun(db, run.id, { status: "failed", reason: message, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0, events: [{ type: "error", message }] });
    throw e;
  }
}
