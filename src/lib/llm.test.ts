import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Replay mode: no key, so `structured` must answer from recordings only.
vi.mock("./env", () => ({ serverEnv: () => ({ databaseUrl: null, live: null, record: false }) }));
vi.mock("../../samples/recordings.json", () => {
  return {
    default: {
      // Filled in below once we know the key.
    },
  };
});

const { structured, inputKey, costMicros, LlmError } = await import("./llm");
const recordings = (await import("../../samples/recordings.json")).default as Record<string, unknown>;

const call = { purpose: "test", promptVersion: "t-v1", system: "sys", user: "hello", schema: z.object({ answer: z.string() }), maxTokens: 100, effort: "low" as const };
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("structured() in replay mode", () => {
  it("answers from the recording for the exact same prompt and input", async () => {
    recordings[inputKey("t-v1", "sys", "hello")] = { promptVersion: "t-v1", model: "claude-opus-5-5", output: { answer: "hi" }, usage, durationMs: 1200, recordedAt: "2026-11-18T00:00:00Z" };
    const r = await structured(call);
    expect(r).toMatchObject({ output: { answer: "hi" }, mode: "replay", model: "claude-opus-5-5", costMicros: 8000 });
  });

  it("misses (and says why) when the prompt version or input changed", async () => {
    await expect(structured({ ...call, promptVersion: "t-v2" })).rejects.toThrow(/prompt or the input changed/);
    await expect(structured({ ...call, user: "hello!" })).rejects.toBeInstanceOf(LlmError);
  });

  it("re-validates a recording against today's schema", async () => {
    await expect(structured({ ...call, schema: z.object({ answer: z.number() }) })).rejects.toThrow(/no longer matches the schema/);
  });
});

describe("cost", () => {
  it("prices per model in micro-dollars, cache reads at the cache rate", () => {
    expect(costMicros("claude-opus-5-5", usage)).toBe(8000); // 1000×$4/M + 200×$20/M = $0.008
    expect(costMicros("claude-opus-5-5", { ...usage, inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000 })).toBe(2000);
    expect(costMicros("unknown-model", usage)).toBe(0);
  });
});
