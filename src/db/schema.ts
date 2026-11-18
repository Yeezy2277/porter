import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp, vector } from "drizzle-orm/pg-core";
import type { Mapping } from "@/core/mapping";
import type { Candidate, DecidedBy, Decision } from "@/core/link";
import type { AgentEvent, Provenance, RunStatus } from "@/core/agent";
import type { EntryDraft } from "@/core/model";

/**
 * Every model call is logged: what was asked (by prompt version and input
 * hash, not the text), how it was answered (live or replayed), and what it
 * cost. That log is what the cost panel and, later, the evals read.
 */
export const llmCalls = pgTable("llm_calls", {
  id: serial("id").primaryKey(),
  purpose: text("purpose").notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputKey: text("input_key").notNull(),
  model: text("model").notNull(),
  mode: text("mode").$type<"live" | "replay">().notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  /** US dollars × 1,000,000, so sums stay exact integers. */
  costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  output: jsonb("output").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One mapping per content type: proposed (by Claude or a person), then approved. */
export const mappings = pgTable("mappings", {
  contentType: text("content_type").primaryKey(),
  mapping: jsonb("mapping").$type<Mapping>().notNull(),
  status: text("status").$type<"proposed" | "approved">().notNull(),
  /** The call that proposed it; null when a person wrote or edited it. */
  proposedBy: integer("proposed_by").references(() => llmCalls.id),
  edited: integer("edited").notNull().default(0),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The retrieval index: existing target entries with an embedding and a
 * normalised search text. HNSW serves nearest-neighbour queries and GIN the
 * full-text ones; at a few dozen rows a scan would do, but the same schema
 * holds for a space with tens of thousands of entries.
 */
export const entities = pgTable(
  "entities",
  {
    entryId: text("entry_id").primaryKey(),
    contentType: text("content_type").$type<"author" | "topic">().notNull(),
    name: text("name").notNull(),
    text: text("text").notNull(),
    searchText: text("search_text").notNull(),
    /** Which embedder made the vector; queries only compare within one. */
    embedder: text("embedder").notNull(),
    embedding: vector("embedding", { dimensions: 512 }).notNull(),
  },
  (t) => [
    index("entities_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("entities_search_gin").using("gin", sql`to_tsvector('english', ${t.searchText})`),
  ],
);

/** One decision per source author or term: proposed by a rule, Claude or a person, then approved. */
export const links = pgTable("links", {
  sourceKey: text("source_key").primaryKey(),
  contentType: text("content_type").$type<"author" | "topic">().notNull(),
  decision: text("decision").$type<Decision>().notNull(),
  entryId: text("entry_id"),
  decidedBy: text("decided_by").$type<DecidedBy>().notNull(),
  reason: text("reason").notNull(),
  evidence: text("evidence").notNull(),
  /** Problems code found in Claude's decision; a row with problems needs a person. */
  problems: jsonb("problems").$type<string[]>().notNull().default([]),
  /** What retrieval returned, kept so the review page doesn't search (or pay for embeddings) again. */
  candidates: jsonb("candidates").$type<Candidate[]>().notNull().default([]),
  vectorUsed: integer("vector_used").notNull().default(1),
  callId: integer("call_id").references(() => llmCalls.id),
  status: text("status").$type<"proposed" | "approved">().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One agent run for one post, with every event it emitted (the trace the UI replays). */
export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull(),
  mode: text("mode").$type<"live" | "replay">().notNull(),
  status: text("status").$type<RunStatus | "running">().notNull(),
  reason: text("reason").notNull().default(""),
  turns: integer("turns").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  events: jsonb("events").$type<AgentEvent[]>().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** The review queue: one draft per post, with where each value came from. */
export const entries = pgTable("entries", {
  postId: integer("post_id").primaryKey(),
  entryId: text("entry_id").notNull(),
  draft: jsonb("draft").$type<EntryDraft>().notNull(),
  provenance: jsonb("provenance").$type<Provenance>().notNull(),
  status: text("status").$type<"in_review" | "flagged" | "approved" | "rejected">().notNull(),
  notes: text("notes").notNull().default(""),
  runId: integer("run_id").references(() => agentRuns.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LlmCallRow = typeof llmCalls.$inferSelect;
export type MappingRow = typeof mappings.$inferSelect;
export type EntityRow = typeof entities.$inferSelect;
export type LinkRow = typeof links.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type EntryRow = typeof entries.$inferSelect;
