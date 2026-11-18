import type { AgentEvent, Provenance, RunStatus } from "@/core/agent";
import type { EntryDraft } from "@/core/model";
import { desc, eq, sql } from "drizzle-orm";
import type { Mapping } from "@/core/mapping";
import type { CallResult } from "@/lib/llm";
import type { Db } from "./client";
import { agentRuns, entries, llmCalls, mappings, type AgentRunRow, type EntryRow, type LlmCallRow, type MappingRow } from "./schema";

export async function logCall(db: Db, purpose: string, promptVersion: string, r: CallResult<unknown>): Promise<LlmCallRow> {
  const [row] = await db
    .insert(llmCalls)
    .values({
      purpose,
      promptVersion,
      inputKey: r.inputKey,
      model: r.model,
      mode: r.mode,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      costMicros: r.costMicros,
      durationMs: r.durationMs,
      output: r.output as object,
    })
    .returning();
  if (!row) throw new Error("Insert returned nothing");
  return row;
}

export async function recentCalls(db: Db, limit = 10): Promise<LlmCallRow[]> {
  return db.select().from(llmCalls).orderBy(desc(llmCalls.id)).limit(limit);
}

export async function spend(db: Db): Promise<{ calls: number; liveMicros: number }> {
  const [row] = await db
    .select({ calls: sql<number>`count(*)::int`, liveMicros: sql<number>`coalesce(sum(case when ${llmCalls.mode} = 'live' then ${llmCalls.costMicros} else 0 end), 0)::bigint` })
    .from(llmCalls);
  return { calls: Number(row?.calls ?? 0), liveMicros: Number(row?.liveMicros ?? 0) };
}

export async function getMapping(db: Db, contentType: string): Promise<MappingRow | null> {
  const [row] = await db.select().from(mappings).where(eq(mappings.contentType, contentType));
  return row ?? null;
}

/** A new proposal (from Claude or an edit) always resets approval: what was approved is no longer what's stored. */
export async function saveProposal(db: Db, mapping: Mapping, proposedBy: number | null): Promise<MappingRow> {
  const now = new Date();
  const values = { contentType: mapping.contentType, mapping, status: "proposed" as const, proposedBy, edited: proposedBy === null ? 1 : 0, approvedAt: null, updatedAt: now };
  const [row] = await db
    .insert(mappings)
    .values(values)
    .onConflictDoUpdate({
      target: mappings.contentType,
      set: proposedBy === null ? { mapping, status: "proposed", edited: sql`${mappings.edited} + 1`, approvedAt: null, updatedAt: now } : { ...values },
    })
    .returning();
  if (!row) throw new Error("Upsert returned nothing");
  return row;
}

/** Approves only the version the reviewer saw: `updatedAt` must match, or someone changed it in between. */
export async function approve(db: Db, contentType: string, seenUpdatedAt: string): Promise<MappingRow | null> {
  const current = await getMapping(db, contentType);
  if (!current || current.updatedAt.toISOString() !== seenUpdatedAt) return null;
  const [row] = await db.update(mappings).set({ status: "approved", approvedAt: new Date() }).where(eq(mappings.contentType, contentType)).returning();
  return row ?? null;
}

export async function resetMapping(db: Db, contentType: string): Promise<void> {
  await db.delete(mappings).where(eq(mappings.contentType, contentType));
}

// Stage 04: agent runs and the review queue


/** Starts a run unless one for this post is already going (within 5 minutes: older ones crashed). */
export async function startRun(db: Db, postId: number, mode: "live" | "replay"): Promise<AgentRunRow | null> {
  const running = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(sql`${agentRuns.postId} = ${postId} and ${agentRuns.status} = 'running' and ${agentRuns.startedAt} > now() - interval '5 minutes'`);
  if (running.length) return null;
  const [row] = await db.insert(agentRuns).values({ postId, mode, status: "running" }).returning();
  return row ?? null;
}

export async function finishRun(
  db: Db,
  id: number,
  r: { status: RunStatus; reason: string; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicros: number; events: AgentEvent[] },
): Promise<void> {
  await db.update(agentRuns).set({ ...r, finishedAt: new Date() }).where(eq(agentRuns.id, id));
}

export async function latestRuns(db: Db): Promise<AgentRunRow[]> {
  return db.select().from(agentRuns).orderBy(desc(agentRuns.id)).limit(50);
}

export async function saveEntry(db: Db, e: { postId: number; draft: EntryDraft; provenance: Provenance; status: EntryRow["status"]; notes: string; runId: number }): Promise<void> {
  const values = { postId: e.postId, entryId: e.draft.id, draft: e.draft, provenance: e.provenance, status: e.status, notes: e.notes, runId: e.runId, updatedAt: new Date() };
  await db.insert(entries).values(values).onConflictDoUpdate({ target: entries.postId, set: values });
}

export async function getEntries(db: Db): Promise<EntryRow[]> {
  return db.select().from(entries).orderBy(entries.postId);
}

/** A reviewer's edit to an agent-written field: the value changes and its origin becomes "person". */
export async function editEntryField(db: Db, postId: number, field: string, value: string, seenUpdatedAt: string): Promise<EntryRow | null> {
  const [row] = await db.select().from(entries).where(eq(entries.postId, postId));
  if (!row || row.updatedAt.toISOString() !== seenUpdatedAt) return null;
  const draft = { ...row.draft, fields: { ...row.draft.fields, [field]: value } };
  const provenance = { ...row.provenance, [field]: { origin: "person" as const, detail: "Edited in review" } };
  const [updated] = await db.update(entries).set({ draft, provenance, status: "in_review", updatedAt: new Date() }).where(eq(entries.postId, postId)).returning();
  return updated ?? null;
}

export async function setEntryStatus(db: Db, postId: number, status: "approved" | "rejected", seenUpdatedAt: string): Promise<EntryRow | null> {
  const [row] = await db.select().from(entries).where(eq(entries.postId, postId));
  if (!row || row.updatedAt.toISOString() !== seenUpdatedAt) return null;
  const [updated] = await db.update(entries).set({ status, updatedAt: new Date() }).where(eq(entries.postId, postId)).returning();
  return updated ?? null;
}
