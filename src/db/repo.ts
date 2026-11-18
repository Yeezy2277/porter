import { desc, eq, sql } from "drizzle-orm";
import type { Mapping } from "@/core/mapping";
import type { CallResult } from "@/lib/llm";
import type { Db } from "./client";
import { llmCalls, mappings, type LlmCallRow, type MappingRow } from "./schema";

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
