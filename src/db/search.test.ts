import { beforeAll, describe, expect, it } from "vitest";
import entriesJson from "../../samples/contentful-entries.json";
import { targetEntities, type LinkDecision } from "@/core/link";
import { HASHING_ID, hashingEmbed } from "@/core/hashing";
import { openPglite, type Db } from "./client";
import { approveLinks, getLinks, indexState, keywordSearch, overrideLink, rebuildIndex, saveLinkProposals, vectorSearch } from "./search";

const targets = targetEntities(entriesJson);
let db: Db;

beforeAll(async () => {
  db = await openPglite();
  await rebuildIndex(
    db,
    targets.map((entity) => ({ entity, embedding: hashingEmbed(entity.text) })),
    HASHING_ID,
  );
});

describe("retrieval index (pgvector + full text)", () => {
  it("indexes every entry under one embedder", async () => {
    expect(await indexState(db)).toEqual({ rows: targets.length, embedder: HASHING_ID });
  });

  it("finds the nearest author by cosine similarity, within the content type", async () => {
    const hits = await vectorSearch(db, "author", HASHING_ID, hashingEmbed("Author: Ana Lucia Ortega. Lisbon-based food writer."), 3);
    expect(hits[0]?.entryId).toBe("author-ortega");
    expect(hits.every((h) => h.entryId.startsWith("author-"))).toBe(true);
    expect(await vectorSearch(db, "author", "some-other-embedder", hashingEmbed("Ana"), 3)).toEqual([]);
  });

  it("matches any word in full text, accents and punctuation ignored", async () => {
    // English stemming: "Trains" finds "trains", "Eating" finds "eat". Labels like "Tag:" are ignored.
    expect((await keywordSearch(db, "topic", "Category: Trains")).map((h) => h.entryId)).toEqual(["topic-rail"]);
    expect((await keywordSearch(db, "topic", "Category: Eating Out")).map((h) => h.entryId)).toContain("topic-food");
    // Words, not meaning: "Interrail" shares no word with "rail passes", so only vectors can find it.
    expect(await keywordSearch(db, "topic", "Tag: Interrail")).toEqual([]);
    expect((await keywordSearch(db, "author", "Author: Northbound Staff")).map((h) => h.entryId)).toEqual([]);
    expect((await keywordSearch(db, "author", "Ana-Lucía"))[0]?.entryId).toBe("author-ortega");
  });
});

describe("link decisions", () => {
  const d = (source: string, x: Partial<LinkDecision> = {}): LinkDecision => ({ source, decision: "link", entryId: "author-brennan", reason: "", evidence: "", decidedBy: "claude", ...x });

  it("won't approve while a row has problems; a person's override clears them", async () => {
    await saveLinkProposals(db, [
      { decision: d("author:3"), contentType: "author", problems: ["bad evidence"], callId: null },
      { decision: d("author:4", { entryId: "author-sato", decidedBy: "rule" }), contentType: "author", problems: [], callId: null },
    ]);
    expect(await approveLinks(db)).toEqual({ blocked: ["author:3"] });
    await overrideLink(db, "author:3", "link", "author-brennan");
    expect(await approveLinks(db)).toEqual({ approved: 2 });
    expect((await getLinks(db)).map((r) => [r.sourceKey, r.decidedBy, r.status])).toEqual([
      ["author:3", "person", "approved"],
      ["author:4", "rule", "approved"],
    ]);
  });
});
