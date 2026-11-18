import { describe, expect, it, vi } from "vitest";

// Replay everything: recorded Voyage vectors and recorded Claude answers, no keys.
vi.mock("./env", () => ({ serverEnv: () => ({ databaseUrl: null, live: null, voyage: null, record: false, replayFirst: false }) }));
const { openPglite } = await import("@/db/client");
const { embedder } = await import("./embed");
const { buildIndex, proposeLinks } = await import("./link");

describe("the recorded linking run", () => {
  // Fails when the prompt, the sample data, retrieval or the schema change without re-recording:
  // run once with ANTHROPIC_API_KEY, VOYAGE_API_KEY and PORTER_RECORD=true.
  it("replays end to end, and every model decision passes code's checks", async () => {
    expect(embedder()).toEqual({ id: "voyage-3.5-lite-512", mode: "replay" });
    const db = await openPglite();
    expect((await buildIndex(db)).rows).toBe(52);
    const { proposals, calls } = await proposeLinks(db);
    expect(calls).toBe(2);
    expect(proposals.filter((p) => p.problems.length)).toEqual([]);
    expect(proposals.every((p) => p.vectorUsed)).toBe(true);
    const chosen = Object.fromEntries(proposals.map((p) => [p.source.name, p.decision.entryId ?? p.decision.decision]));
    expect(chosen).toMatchObject({
      "Ana Lucia Ortega": "author-ortega", // rule: same name
      "Tom B.": "author-brennan", // not Tomas Brenner: the bios decide
      "Chidi O.": "author-okafor",
      "Eating Out": "topic-food", // no shared words; found by meaning
      Interrail: "topic-rail",
      Kyoto: "topic-japan",
      Uncategorized: "skip", // rule: WordPress default
    });
  }, 60_000);
});
