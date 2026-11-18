import { bigint, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { Mapping } from "@/core/mapping";

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

export type LlmCallRow = typeof llmCalls.$inferSelect;
export type MappingRow = typeof mappings.$inferSelect;
