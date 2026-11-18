import { beforeEach, describe, expect, it } from "vitest";
import goldenJson from "../../samples/golden/mapping-article.json";
import { Mapping } from "@/core/mapping";
import { openPglite, type Db } from "./client";
import { approve, getMapping, logCall, saveProposal, spend } from "./repo";

const golden = Mapping.parse(goldenJson);
let db: Db;

beforeEach(async () => {
  db = await openPglite();
});

const result = (mode: "live" | "replay", costMicros: number) => ({
  output: golden,
  model: "claude-opus-5-5",
  mode,
  inputKey: "k",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costMicros,
  durationMs: 10,
});

describe("mapping lifecycle", () => {
  it("approves only the version the reviewer saw", async () => {
    const call = await logCall(db, "field mapping", "map-v1", result("live", 5000));
    const first = await saveProposal(db, golden, call.id);
    // Someone edits it after the page was loaded…
    await new Promise((r) => setTimeout(r, 5));
    await saveProposal(db, { ...golden, questions: [] }, null);
    // …so approving the old version fails, and the current one is still unapproved.
    expect(await approve(db, "article", first.updatedAt.toISOString())).toBeNull();
    const current = (await getMapping(db, "article"))!;
    expect(current).toMatchObject({ status: "proposed", edited: 1 });
    expect((await approve(db, "article", current.updatedAt.toISOString()))?.status).toBe("approved");
  });

  it("drops an approval when the mapping changes again", async () => {
    const row = await saveProposal(db, golden, null);
    await approve(db, "article", row.updatedAt.toISOString());
    const after = await saveProposal(db, golden, null);
    expect(after).toMatchObject({ status: "proposed", approvedAt: null, edited: 2 });
  });

  it("sums live spend and ignores replays", async () => {
    await logCall(db, "field mapping", "map-v1", result("live", 5000));
    await logCall(db, "field mapping", "map-v1", result("replay", 5000));
    expect(await spend(db)).toEqual({ calls: 2, liveMicros: 5000 });
  });
});
