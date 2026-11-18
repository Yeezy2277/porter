import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp, vector } from "drizzle-orm/pg-core";
import type { Mapping } from "@/core/mapping";
import type { Candidate, DecidedBy, Decision } from "@/core/link";

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

export type LlmCallRow = typeof llmCalls.$inferSelect;
export type MappingRow = typeof mappings.$inferSelect;
export type EntityRow = typeof entities.$inferSelect;
export type LinkRow = typeof links.$inferSelect;
