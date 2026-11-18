import { z } from "zod";
import { ungrounded } from "./grounding";
import type { Pending } from "./mapping";
import { validateField, type ContentType, type EntryDraft, type Field, type Resolver } from "./model";

/**
 * The migration agent's rules, free of any model or framework.
 *
 * The agent assembles one entry. Code already filled what it can (stage 01
 * body, stage 02 mapping, stage 03 links); the agent writes only the fields
 * the mapping marked "generate", and every value it writes is checked here
 * before it lands in the draft. The fields it may write are an enum built
 * from the mapping, so it can't touch the title, the body or anything else.
 */

export const AGENT_LIMITS = {
  /** Model turns per post. A clean run takes about five; the rest is room for retries. */
  maxTurns: 10,
  /** Live spend per post, in micro-dollars ($0.40). */
  maxCostMicros: 400_000,
  /** Rejected writes per field before the agent is told to flag the post instead. */
  maxRejectsPerField: 3,
} as const;

export type FieldOrigin = "mapping" | "link" | "agent" | "person";

/** Where each value in a draft came from: the review queue shows it next to the value. */
export type Provenance = Record<string, { origin: FieldOrigin; detail: string }>;

/** Fields the agent may write for this post: what the mapping left as `generate`. */
export function writableFields(pending: readonly Pending[]): string[] {
  return pending.filter((p) => p.transform === "generate").map((p) => p.target);
}

export type WriteCheck = { ok: true } | { ok: false; problems: string[] };

/**
 * A generated value must pass the field's own rules and, for free text,
 * mention no number or proper name that isn't in the source. A classified
 * value (a field with an `in` list) is checked by the list instead: "Europe"
 * needn't appear in the article to be right.
 */
export function checkWrite(field: Field, value: string, sourceText: string, resolve: Resolver): WriteCheck {
  const problems = [...validateField(field, value.trim(), resolve)];
  const classified = field.validations.some((v) => v.in);
  if (!classified) {
    const facts = ungrounded(value, sourceText);
    if (facts.length) problems.push(`Not in the source: ${facts.join(", ")}. Use only names and numbers the article contains.`);
  }
  if (!value.trim()) problems.push("Empty value");
  return problems.length ? { ok: false, problems } : { ok: true };
}

/**
 * What blocks submitting: rule problems on the draft, and *required* fields
 * still waiting. An optional field may stay empty on purpose (a region for an
 * article set nowhere in particular); the reviewer sees it empty.
 */
export function submitBlockers(draft: EntryDraft, ct: ContentType, problems: readonly { field: string; message: string }[], waiting: readonly string[]): string[] {
  return [
    ...problems.map((p) => `${p.field}: ${p.message}`),
    ...waiting.filter((f) => ct.fields.find((x) => x.id === f)?.required && !(f in draft.fields)).map((f) => `${f}: not written yet`),
  ];
}

// Tool inputs. The model's tool calls are validated against these before anything runs.
export const ToolInputs = {
  read_post: z.object({}),
  apply_mapping: z.object({}),
  write_field: z.object({
    field: z.string().describe("One of the fields listed as writable"),
    value: z.string().describe("The full value. Plain text, no markdown."),
  }),
  validate_draft: z.object({}),
  submit_for_review: z.object({ notes: z.string().describe("One or two sentences for the reviewer: anything uncertain") }),
  flag_for_human: z.object({ reason: z.string().describe("Why this post can't be completed automatically") }),
} as const;

export type ToolName = keyof typeof ToolInputs;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_post:
    "Read the source post: title, author, terms, excerpt, SEO description and the full body as plain text. Read it before writing anything; every name and number you write must come from it.",
  apply_mapping:
    "Fill the draft from the approved field mapping and the approved author/topic links. Returns the filled fields, the fields you are expected to write, and any problems. Run it once, before writing fields.",
  write_field:
    "Write one of the fields the mapping left for you. The value is checked against the field's rules and against the source (no names or numbers that aren't in the post). If it is rejected, read the problems and write it again.",
  validate_draft: "Check the whole draft against the content type's rules. Returns the problems, or none.",
  submit_for_review: "Finish: send the draft to the human review queue. Only works when validate_draft finds no problems and every field you were expected to write is written.",
  flag_for_human: "Finish without a complete draft when the post can't be migrated correctly (for example, a required value has no source). A person takes over.",
};

/** One event of a run, as the UI shows it and the database keeps it. */
export type AgentEvent =
  | { type: "start"; runId: number; postId: number; mode: "live" | "replay" }
  | { type: "turn"; n: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number }
  | { type: "note"; text: string }
  | { type: "tool"; n: number; name: string; input: unknown; ok: boolean; summary: string }
  | { type: "done"; status: RunStatus; reason: string; entryId: string | null; costMicros: number; turns: number }
  | { type: "error"; message: string };

export type RunStatus = "submitted" | "flagged" | "stopped" | "failed";
