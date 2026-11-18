import { describe, expect, it, vi } from "vitest";

// Replay the demo's whole path with no keys: recorded mapping, vectors, link decisions and agent turns.
vi.mock("./env", () => ({ serverEnv: () => ({ databaseUrl: null, live: null, voyage: null, record: false, replayFirst: false }) }));
const { openPglite } = await import("@/db/client");
const { approve, saveProposal, logCall } = await import("@/db/repo");
const { approveLinks, getLinks } = await import("@/db/search");
const { structured, turn } = await import("./llm");
const { mappingCall } = await import("./map");
const { buildIndex, proposeLinks } = await import("./link");
const { runAgent } = await import("./agent");
const { source } = await import("@/config/demo");
const { migratable } = await import("@/core/source");

describe("the recorded demo path", () => {
  // Fails if any stage changes without recording again (PORTER_RECORD=true with PORTER_REPLAY_FIRST=true).
  it("replays mapping, linking and the agent for every post, and every post is submitted", async () => {
    const db = await openPglite();
    const proposal = await structured(mappingCall("article"));
    const row = await saveProposal(db, proposal.output, (await logCall(db, "field mapping", "map-v1", proposal)).id);
    await approve(db, "article", row.updatedAt.toISOString());
    await buildIndex(db);
    await proposeLinks(db);
    expect(await approveLinks(db)).toEqual({ approved: 21 });
    const links = await getLinks(db);

    const results: Record<number, string> = {};
    for (const post of source.posts.filter((p) => migratable(p).ok)) {
      const out = await runAgent({ post, mapping: proposal.output, links, runId: 1 }, { turn, emit: () => {} });
      results[post.id] = out.status;
      // Every value the agent wrote passed the checks when it was written; none were rejected.
      expect(out.events.filter((e) => e.type === "tool" && !e.ok)).toEqual([]);
    }
    expect(Object.values(results).every((s) => s === "submitted")).toBe(true);
  }, 120_000);
});
