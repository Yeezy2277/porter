import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import recordingsJson from "../../samples/recordings.json";
import turnsJson from "../../samples/agent-turns.json";
import { serverEnv } from "./env";

/**
 * One way to ask Claude for structured output, with two backends:
 *
 * - live: the Messages API with a Zod output schema (the API constrains the
 *   answer to the schema, and the SDK parses it), refusal fallback on;
 * - replay: the same answer, recorded earlier, looked up by a hash of
 *   (prompt version, system, user). The demo and CI run on replays, so they
 *   are free, deterministic and need no key.
 *
 * The hash means a changed prompt or input can't silently reuse an old
 * answer: it misses and says so.
 */

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type Recording = { promptVersion: string; model: string; output: unknown; usage: Usage; durationMs: number; recordedAt: string };
export type CallResult<T> = { output: T; model: string; mode: "live" | "replay"; inputKey: string; usage: Usage; costMicros: number; durationMs: number };

export type StructuredCall<S extends z.ZodType> = {
  purpose: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: S;
  maxTokens: number;
  effort: "low" | "medium" | "high";
  /** A different model than the app's (the eval judge). Part of the recording key. */
  model?: string;
};

export class LlmError extends Error {}

const recordings = recordingsJson as unknown as Record<string, Recording>;

/** Per million tokens, USD. Cache writes cost 1.25× input; reads are listed. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function costMicros(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Math.round(u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.input * 1.25);
}

export function inputKey(promptVersion: string, system: string, user: string): string {
  return createHash("sha256").update(JSON.stringify([promptVersion, system, user])).digest("hex").slice(0, 24);
}

let client: Anthropic | null = null;
const api = () => (client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 }));

export async function structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<CallResult<z.infer<S>>> {
  const key = inputKey(call.model ? `${call.promptVersion}@${call.model}` : call.promptVersion, call.system, call.user);
  const env = serverEnv();
  if (env.live && !(env.replayFirst && recordings[key])) {
    const result = await live(call, call.model ?? env.live.model, key);
    if (env.record) await record(key, { promptVersion: call.promptVersion, model: result.model, output: result.output, usage: result.usage, durationMs: result.durationMs, recordedAt: new Date().toISOString() });
    return result;
  }
  const rec = recordings[key];
  if (!rec) {
    throw new LlmError(
      `No recorded answer for this ${call.purpose} input (prompt ${call.promptVersion}). The prompt or the input changed since it was recorded. Set ANTHROPIC_API_KEY to run it live, with PORTER_RECORD=true to save the answer.`,
    );
  }
  // Replays still go through the schema: a recording from an older schema fails loudly.
  const parsed = call.schema.safeParse(rec.output);
  if (!parsed.success) throw new LlmError(`The recorded ${call.purpose} answer no longer matches the schema; record it again.`);
  return { output: parsed.data, model: rec.model, mode: "replay", inputKey: key, usage: rec.usage, costMicros: costMicros(rec.model, rec.usage), durationMs: rec.durationMs };
}

async function live<S extends z.ZodType>(call: StructuredCall<S>, model: string, key: string): Promise<CallResult<z.infer<S>>> {
  const started = Date.now();
  try {
    // Haiku has no server-side refusal fallback; the Opus/Sonnet calls keep it.
    const fallback: { betas?: Anthropic.AnthropicBeta[]; fallbacks?: "default" } = model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
    const res = await api().beta.messages.parse({
      model,
      max_tokens: call.maxTokens,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      output_config: { effort: call.effort, format: betaZodOutputFormat(call.schema) },
      ...fallback,
    });
    // An eval scored by the wrong model measures nothing: fail loudly on a silent substitution.
    if (call.model && res.model !== model) throw new LlmError(`Asked for ${model}, served by ${res.model}.`);
    if (res.stop_reason === "refusal") throw new LlmError(`Claude declined the ${call.purpose} request.`);
    if (res.stop_reason === "max_tokens") throw new LlmError(`Claude's ${call.purpose} answer was cut off; raise maxTokens.`);
    if (!res.parsed_output) throw new LlmError(`Claude's ${call.purpose} answer didn't match the schema.`);
    const usage: Usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    // The fallback model may have answered; price what actually ran.
    const served = res.model;
    return { output: res.parsed_output as z.infer<S>, model: served, mode: "live", inputKey: key, usage, costMicros: costMicros(served, usage), durationMs: Date.now() - started };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new LlmError("The Anthropic API key was rejected.");
    if (e instanceof Anthropic.RateLimitError) throw new LlmError("Anthropic rate limit reached; try again in a minute.");
    if (e instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${e.status ?? ""}: ${e.message}`.trim());
    throw new LlmError("Couldn't reach the Anthropic API.");
  }
}

/** Local only: writes the answer into samples/recordings.json, keys sorted so diffs stay small. */
async function record(key: string, rec: Recording): Promise<void> {
  if (process.env.VERCEL) return;
  const fs = await import("node:fs/promises");
  const path = (await import("node:path")).join(process.cwd(), "samples", "recordings.json");
  const current = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, Recording>;
  current[key] = rec;
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
  recordings[key] = rec;
}

// ---------------------------------------------------------------------------
// Agent turns: one Messages API call with tools, recorded like everything else.


export type TurnRecording = {
  promptVersion: string;
  model: string;
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  usage: Usage;
  durationMs: number;
  recordedAt: string;
};

export type TurnRequest = {
  promptVersion: string;
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens: number;
  effort: "low" | "medium" | "high";
};

export type TurnResult = Omit<TurnRecording, "promptVersion" | "recordedAt"> & { mode: "live" | "replay"; inputKey: string; costMicros: number };
export type TurnFn = (req: TurnRequest) => Promise<TurnResult>;

const turns = turnsJson as unknown as Record<string, TurnRecording>;

/**
 * The key covers the whole conversation so far (tool results included), so a
 * replay only matches when every earlier step happened exactly the same way.
 */
export const turnKey = (r: TurnRequest) => inputKey(r.promptVersion, r.system, JSON.stringify([r.tools, r.messages]));

export const turn: TurnFn = async (req) => {
  const key = turnKey(req);
  const env = serverEnv();
  if (!env.live || (env.replayFirst && turns[key])) {
    const rec = turns[key];
    if (!rec) throw new LlmError(`No recorded agent turn for this step (prompt ${req.promptVersion}). The mapping or link decisions (or an earlier step) differ from the recorded demo: reset them to Claude's proposals to replay, or set ANTHROPIC_API_KEY to run live.`);
    return { model: rec.model, content: rec.content, stopReason: rec.stopReason, usage: rec.usage, durationMs: rec.durationMs, mode: "replay", inputKey: key, costMicros: costMicros(rec.model, rec.usage) };
  }
  const started = Date.now();
  try {
    const res = await api().beta.messages.create({
      model: env.live.model,
      max_tokens: req.maxTokens,
      system: req.system,
      tools: req.tools,
      messages: req.messages,
      output_config: { effort: req.effort },
      // The system prompt and tools never change within a run, and each turn
      // resends the whole conversation: automatic caching makes repeats cheap.
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const usage: Usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    const result: TurnResult = { model: res.model, content: res.content, stopReason: res.stop_reason, usage, durationMs: Date.now() - started, mode: "live", inputKey: key, costMicros: costMicros(res.model, usage) };
    if (env.record) await recordTurn(key, { promptVersion: req.promptVersion, model: res.model, content: res.content, stopReason: res.stop_reason, usage, durationMs: result.durationMs, recordedAt: new Date().toISOString() });
    return result;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new LlmError("The Anthropic API key was rejected.");
    if (e instanceof Anthropic.RateLimitError) throw new LlmError("Anthropic rate limit reached; try again in a minute.");
    if (e instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${e.status ?? ""}: ${e.message}`.trim());
    throw new LlmError("Couldn't reach the Anthropic API.");
  }
};

async function recordTurn(key: string, rec: TurnRecording): Promise<void> {
  if (process.env.VERCEL) return;
  const fs = await import("node:fs/promises");
  const path = (await import("node:path")).join(process.cwd(), "samples", "agent-turns.json");
  const current = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, TurnRecording>;
  current[key] = rec;
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(path, `${JSON.stringify(sorted, null, 1)}\n`);
  turns[key] = rec;
}
