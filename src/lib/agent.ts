import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AGENT_LIMITS, checkWrite, submitBlockers, TOOL_DESCRIPTIONS, ToolInputs, writableFields, type AgentEvent, type Provenance, type RunStatus, type ToolName } from "@/core/agent";
import { visibleText } from "@/core/grounding";
import type { Mapping } from "@/core/mapping";
import { contentType, validateEntry, type EntryDraft, type Field } from "@/core/model";
import type { SourcePost } from "@/core/source";
import { model } from "@/config/demo";
import type { LinkRow } from "@/db/schema";
import { AGENT_PROMPT_VERSION, AGENT_SYSTEM, agentTask } from "@/prompts/agent";
import { preview, resolver } from "./map";
import type { TurnFn } from "./llm";

/**
 * The agent loop, written by hand rather than with the SDK's tool runner,
 * because each turn is recorded for replay, the loop enforces a turn and
 * cost budget, and every tool input is validated before it runs. The model
 * call is injected, so tests drive the loop with a scripted model.
 */

type Block = Anthropic.Beta.BetaContentBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type AgentInput = { post: SourcePost; mapping: Mapping; links: readonly LinkRow[]; runId: number };
export type AgentOutcome = { status: RunStatus; reason: string; draft: EntryDraft; provenance: Provenance; notes: string; turns: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicros: number }; events: AgentEvent[] };

const rulesOf = (f: Field) =>
  f.validations
    .map((v) => (v.size ? `${v.size.min ?? 0}–${v.size.max ?? "∞"} characters` : v.in ? `one of: ${v.in.join(", ")}` : v.regexp ? `pattern ${v.regexp.pattern}` : null))
    .filter(Boolean)
    .join("; ") || "no extra rules";

/** Zod → the JSON Schema a tool takes: no `$schema` key, closed objects (needed for strict tools). */
function jsonSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void _drop;
  return { ...rest, type: "object", additionalProperties: false } as Anthropic.Beta.BetaTool.InputSchema;
}

const shorten = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

export async function runAgent(input: AgentInput, deps: { turn: TurnFn; emit: (e: AgentEvent) => void }): Promise<AgentOutcome> {
  const ct = contentType(model, input.mapping.contentType);
  const base = preview(input.mapping, input.post, input.links);
  const writable = writableFields(base.pending);
  const sourceText = [input.post.title, input.post.excerpt, input.post.seoDescription, visibleText(input.post.html)].join("\n");
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    deps.emit(e);
  };

  // Run state. The draft starts empty; apply_mapping fills it, as the agent would see in a real tool.
  let draft: EntryDraft = { ...base.draft, fields: {} };
  const provenance: Provenance = {};
  let mapped = false;
  const rejects = new Map<string, number>();
  let finish: { status: RunStatus; reason: string; notes: string } | null = null;

  const tools: Anthropic.Beta.BetaTool[] = (Object.keys(ToolInputs) as ToolName[])
    .filter((name) => name !== "write_field" || writable.length > 0)
    .map((name) => {
      // write_field's field is an enum of exactly the fields this post leaves to the agent.
      const schema = name === "write_field" ? ToolInputs.write_field.extend({ field: z.enum(writable as [string, ...string[]]) }) : ToolInputs[name];
      return { name, description: TOOL_DESCRIPTIONS[name], input_schema: jsonSchema(schema), strict: true };
    });

  const run = (name: ToolName, raw: unknown): { ok: boolean; content: string; summary: string } => {
    const parsed = (name === "write_field" ? ToolInputs.write_field.extend({ field: z.enum(writable as [string, ...string[]]) }) : ToolInputs[name]).safeParse(raw);
    if (!parsed.success) return { ok: false, content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, summary: "invalid input" };
    switch (name) {
      case "read_post": {
        const p = input.post;
        const body = visibleText(p.html);
        return {
          ok: true,
          summary: `read ${body.split(" ").length} words`,
          content: JSON.stringify({
            id: p.id,
            title: p.title,
            author: p.author?.name ?? null,
            publishedAt: p.publishedAt,
            terms: p.terms.map((t) => `${t.kind}: ${t.name}`),
            excerpt: p.excerpt || null,
            seoDescription: p.seoDescription || null,
            body,
          }),
        };
      }
      case "apply_mapping": {
        mapped = true;
        draft = { ...base.draft, fields: { ...base.draft.fields } };
        for (const f of Object.keys(draft.fields)) {
          const linked = f === "author" || f === "topics";
          provenance[f] = { origin: linked ? "link" : "mapping", detail: linked ? "Approved in stage 03" : (input.mapping.fields.find((m) => m.target === f)?.transform ?? "mapping") };
        }
        const waiting = base.pending.filter((p) => p.transform !== "generate").map((p) => p.target);
        return {
          ok: true,
          summary: `${Object.keys(draft.fields).length} fields filled, ${writable.length} to write`,
          content: JSON.stringify({
            filled: Object.fromEntries(Object.entries(draft.fields).map(([k, v]) => [k, k === "body" ? "(rich text, converted word for word)" : shorten(v)])),
            yours_to_write: writable.map((f) => {
              const field = ct.fields.find((x) => x.id === f) as Field;
              return { field: f, name: field.name, required: field.required, rules: rulesOf(field) };
            }),
            waiting_on_people: waiting,
            used_fallback: base.usedFallback,
            problems: base.problems.map((p) => `${p.field}: ${p.message}`),
          }),
        };
      }
      case "write_field": {
        if (!mapped) return { ok: false, content: "Run apply_mapping first.", summary: "before apply_mapping" };
        const { field, value } = parsed.data as unknown as { field: string; value: string };
        const def = ct.fields.find((x) => x.id === field) as Field;
        const check = checkWrite(def, value, sourceText, resolver);
        if (!check.ok) {
          const n = (rejects.get(field) ?? 0) + 1;
          rejects.set(field, n);
          const hint = n >= AGENT_LIMITS.maxRejectsPerField ? " This field has been rejected several times; if you can't satisfy it, flag the post for a human." : "";
          return { ok: false, content: `Rejected: ${check.problems.join(" ")}${hint}`, summary: `${field} rejected: ${check.problems.join(" ")}` };
        }
        draft = { ...draft, fields: { ...draft.fields, [field]: value.trim() } };
        provenance[field] = { origin: "agent", detail: `Written by the agent, checked against the source (${value.trim().length} characters)` };
        return { ok: true, content: `Saved ${field}.`, summary: `${field} = ${shorten(value.trim())}` };
      }
      case "validate_draft": {
        if (!mapped) return { ok: false, content: "Run apply_mapping first.", summary: "before apply_mapping" };
        const blockers = currentBlockers();
        return { ok: true, content: blockers.length ? `Problems:\n- ${blockers.join("\n- ")}` : "No problems.", summary: blockers.length ? `${blockers.length} problems` : "no problems" };
      }
      case "submit_for_review": {
        const blockers = mapped ? currentBlockers() : ["apply_mapping hasn't run"];
        if (blockers.length) return { ok: false, content: `Can't submit yet:\n- ${blockers.join("\n- ")}`, summary: `blocked: ${blockers.length} problems` };
        finish = { status: "submitted", reason: "Submitted for review", notes: (parsed.data as unknown as { notes: string }).notes };
        return { ok: true, content: "Submitted. You're done.", summary: "submitted" };
      }
      case "flag_for_human": {
        const reason = (parsed.data as unknown as { reason: string }).reason;
        finish = { status: "flagged", reason, notes: reason };
        return { ok: true, content: "Flagged. You're done.", summary: `flagged: ${reason}` };
      }
    }
  };

  const currentBlockers = () => {
    const waiting = [...base.pending.filter((p) => p.transform !== "generate").map((p) => p.target), ...writable.filter((f) => !(f in draft.fields))];
    return submitBlockers(draft, ct, validateEntry(draft, ct, resolver).filter((p) => !waiting.includes(p.field)), waiting);
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: agentTask(input.post) }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0 };
  let turns = 0;
  let nudged = false;
  let stop: { status: RunStatus; reason: string } | null = null;

  while (!finish && !stop) {
    if (turns >= AGENT_LIMITS.maxTurns) {
      stop = { status: "stopped", reason: `Stopped after ${turns} turns without finishing.` };
      break;
    }
    if (usage.costMicros >= AGENT_LIMITS.maxCostMicros) {
      stop = { status: "stopped", reason: `Stopped at the cost limit ($${(usage.costMicros / 1e6).toFixed(2)}).` };
      break;
    }
    const res = await deps.turn({ promptVersion: AGENT_PROMPT_VERSION, system: AGENT_SYSTEM, tools, messages, maxTokens: 4000, effort: "medium" });
    turns++;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens;
    usage.costMicros += res.costMicros;
    emit({ type: "turn", n: turns, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cacheReadTokens: res.usage.cacheReadTokens, cacheWriteTokens: res.usage.cacheWriteTokens, costMicros: res.costMicros });
    // The whole content goes back unchanged, thinking blocks included: the model needs them on the next turn.
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    for (const b of res.content as Block[]) if (b.type === "text" && b.text.trim()) emit({ type: "note", text: b.text.trim() });

    if (res.stopReason === "refusal") {
      stop = { status: "failed", reason: "The model declined this post." };
      break;
    }
    // A tool call cut off at max_tokens may parse as a valid partial object; never run it.
    if (res.stopReason === "max_tokens") {
      stop = { status: "failed", reason: "A turn was cut off at max_tokens." };
      break;
    }
    const calls = (res.content as Block[]).filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      if (nudged) {
        stop = { status: "stopped", reason: "The agent stopped without submitting or flagging." };
        break;
      }
      nudged = true;
      messages.push({ role: "user", content: "Finish with submit_for_review or flag_for_human." });
      continue;
    }
    // All results go back in one user message, in call order.
    const results: ToolResult[] = calls.map((call) => {
      const known = call.name in ToolInputs;
      const out = known ? run(call.name as ToolName, call.input) : { ok: false, content: `Unknown tool ${call.name}.`, summary: "unknown tool" };
      emit({ type: "tool", n: turns, name: call.name, input: call.input, ok: out.ok, summary: out.summary });
      return { type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.ok ? {} : { is_error: true }) };
    });
    messages.push({ role: "user", content: results });
  }

  const end = finish ?? { ...(stop as { status: RunStatus; reason: string }), notes: "" };
  return { status: end.status, reason: end.reason, draft, provenance, notes: end.notes, turns, usage, events };
}
