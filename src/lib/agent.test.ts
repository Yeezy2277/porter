import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import goldenJson from "../../samples/golden/mapping-article.json";
import { Mapping } from "@/core/mapping";
import type { AgentEvent } from "@/core/agent";
import type { LinkRow } from "@/db/schema";
import type { TurnFn, TurnRequest } from "./llm";

vi.mock("./env", () => ({ serverEnv: () => ({ databaseUrl: null, live: null, voyage: null, record: false, replayFirst: false }) }));
const { runAgent } = await import("./agent");
const { source } = await import("@/config/demo");

const mapping = Mapping.parse(goldenJson);
const post = source.posts.find((p) => p.id === 1205)!; // Interrail on a Budget: excerpt too short, so summary is the agent's
const link = (sourceKey: string, entryId: string): LinkRow => ({ sourceKey, contentType: sourceKey.startsWith("author") ? "author" : "topic", decision: "link", entryId, decidedBy: "rule", reason: "", evidence: "", problems: [], candidates: [], vectorUsed: 1, callId: null, status: "approved", updatedAt: new Date() });
const links: LinkRow[] = [link("author:6", "author-desk"), link("category:12", "topic-rail"), { ...link("category:1", ""), decision: "skip", entryId: null }, link("tag:105", "topic-rail"), link("tag:106", "topic-budget")];

/** A scripted model: each turn returns the next list of tool calls, and records what it was sent. */
function scripted(steps: { name: string; input: object }[][]): { turn: TurnFn; sent: TurnRequest[] } {
  const sent: TurnRequest[] = [];
  let i = 0;
  const turn: TurnFn = async (req) => {
    sent.push(structuredClone(req));
    const calls = steps[i++] ?? [];
    const content = calls.map((c, j) => ({ type: "tool_use", id: `t${i}-${j}`, name: c.name, input: c.input })) as unknown as Anthropic.Beta.BetaContentBlock[];
    return { model: "claude-opus-5-5", content, stopReason: calls.length ? "tool_use" : "end_turn", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 1, mode: "replay", inputKey: "k", costMicros: 6000 };
  };
  return { turn, sent };
}

const good = {
  summary: "A month of trains around Europe on as little money as possible, and the ten habits that made a rail pass go further.",
  seo: "Ten ways to make an Interrail pass go further, from flexi passes to night trains and picnics.",
};

describe("the agent loop", () => {
  it("fills the draft, writes its fields and submits; tools are limited to this post's fields", async () => {
    const events: AgentEvent[] = [];
    const { turn, sent } = scripted([
      [{ name: "read_post", input: {} }, { name: "apply_mapping", input: {} }],
      [
        { name: "write_field", input: { field: "summary", value: good.summary } },
        { name: "write_field", input: { field: "seoDescription", value: good.seo } },
        { name: "write_field", input: { field: "region", value: "Europe" } },
      ],
      [{ name: "validate_draft", input: {} }],
      [{ name: "submit_for_review", input: { notes: "Region inferred from the text." } }],
    ]);
    const out = await runAgent({ post, mapping, links, runId: 1 }, { turn, emit: (e) => events.push(e) });
    expect(out).toMatchObject({ status: "submitted", turns: 4, notes: "Region inferred from the text." });
    expect(out.draft.fields).toMatchObject({ summary: good.summary, region: "Europe", author: { sys: { id: "author-desk" } } });
    expect(out.provenance.summary?.origin).toBe("agent");
    expect(out.provenance.title?.origin).toBe("mapping");
    expect(out.provenance.author?.origin).toBe("link");
    const writeTool = sent[0]!.tools.find((t) => t.name === "write_field")!;
    expect((writeTool.input_schema as { properties: { field: { enum: string[] } } }).properties.field.enum).toEqual(["summary", "seoDescription", "region"]);
    expect(events.filter((e) => e.type === "tool").every((e) => e.type === "tool" && e.ok)).toBe(true);
  });

  it("rejects a value with an invented fact, tells the model why, and accepts the rewrite", async () => {
    const { turn, sent } = scripted([
      [{ name: "apply_mapping", input: {} }],
      [{ name: "write_field", input: { field: "summary", value: "Twelve Interrail lessons from 2019, a month of trains around Europe on almost no money." } }],
      [{ name: "write_field", input: { field: "summary", value: good.summary } }],
    ]);
    const out = await runAgent({ post, mapping, links, runId: 1 }, { turn, emit: () => {} });
    const rejection = JSON.stringify(sent[2]!.messages.at(-1));
    expect(rejection).toContain("Not in the source: 2019");
    expect(rejection).toContain('"is_error":true');
    expect(out.draft.fields.summary).toBe(good.summary);
  });

  it("can't write fields outside its list, or submit an incomplete draft", async () => {
    const { turn, sent } = scripted([
      [{ name: "apply_mapping", input: {} }],
      [{ name: "write_field", input: { field: "title", value: "A better title" } }],
      [{ name: "submit_for_review", input: { notes: "" } }],
    ]);
    const out = await runAgent({ post, mapping, links, runId: 1 }, { turn, emit: () => {} });
    expect(JSON.stringify(sent[2]!.messages.at(-1))).toContain("Invalid input: field");
    expect(JSON.stringify(sent[3]!.messages.at(-1))).toContain("summary: not written yet");
    expect(out.draft.fields.title).toBe(post.title);
    expect(out.status).toBe("stopped");
  });

  it("stops at the turn limit and after one nudge when the model stops calling tools", async () => {
    const looping = scripted(Array.from({ length: 20 }, () => [{ name: "validate_draft", input: {} }]));
    expect(await runAgent({ post, mapping, links, runId: 1 }, { turn: looping.turn, emit: () => {} })).toMatchObject({ status: "stopped", turns: 10 });
    const quiet = scripted([[], []]);
    const out = await runAgent({ post, mapping, links, runId: 1 }, { turn: quiet.turn, emit: () => {} });
    expect(out).toMatchObject({ status: "stopped", turns: 2, reason: "The agent stopped without submitting or flagging." });
    expect(quiet.sent[1]!.messages.at(-1)).toEqual({ role: "user", content: "Finish with submit_for_review or flag_for_human." });
  });

  it("submits with an optional field left empty on purpose (regression: region blocked submit)", async () => {
    const editorial = source.posts.find((p) => p.id === 1208)!;
    const own = [link("author:5", "author-okafor"), { ...link("category:1", ""), decision: "skip" as const, entryId: null }, link("tag:107", "topic-sustainable")];
    const { turn } = scripted([
      [{ name: "apply_mapping", input: {} }],
      [
        { name: "write_field", input: { field: "summary", value: "Two years ago the editorial team stopped taking flights under 1,000 km for stories; trips got longer, and better." } },
        { name: "write_field", input: { field: "seoDescription", value: "Why the editorial team stopped flying short-haul, and what changed when the train became part of the story." } },
      ],
      [{ name: "submit_for_review", input: { notes: "Region left empty: the post names no place." } }],
    ]);
    const out = await runAgent({ post: editorial, mapping, links: own, runId: 1 }, { turn, emit: () => {} });
    expect(out.status).toBe("submitted");
    expect(out.draft.fields.region).toBeUndefined();
  });

  it("accepts links to entries the migration creates itself (regression: cross-links and videos were 'missing')", async () => {
    const { preview } = await import("./map");
    const hut = source.posts.find((p) => p.id === 1202)!; // links to the Chamonix post
    const train = source.posts.find((p) => p.id === 1204)!; // embeds a YouTube video
    expect(preview(mapping, hut).problems).toEqual([]);
    expect(preview(mapping, train).problems).toEqual([]);
  });

  it("sends every earlier block back unchanged, so the next turn sees its own thinking", async () => {
    const { turn, sent } = scripted([[{ name: "read_post", input: {} }], [{ name: "flag_for_human", input: { reason: "test" } }]]);
    const out = await runAgent({ post, mapping, links, runId: 1 }, { turn, emit: () => {} });
    expect(out.status).toBe("flagged");
    expect(sent[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
