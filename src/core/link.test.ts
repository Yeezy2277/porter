import { describe, expect, it } from "vitest";
import exportJson from "../../samples/northbound-export.json";
import entriesJson from "../../samples/contentful-entries.json";
import { checkDecision, decisionSchema, fuse, newEntryId, rrf, ruleDecision, sourceEntities, targetEntities, topicLinksFor, type Candidate, type LinkDecision } from "./link";
import { hashingEmbed } from "./hashing";
import { parseExport } from "./source";

const source = parseExport(exportJson);
const targets = targetEntities(entriesJson);
const byId = new Map(targets.map((t) => [t.entryId, t]));
const sources = sourceEntities(source);
const src = (key: string) => sources.find((s) => s.key === key)!;
const cand = (entryId: string, rank = 1): Candidate => ({ entryId, name: byId.get(entryId)!.name, text: byId.get(entryId)!.text, similarity: 0.8, vectorRank: rank, keywordRank: rank, fused: 0.03 });
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("entities", () => {
  it("only lists authors and terms used by posts that migrate", () => {
    expect(sources.filter((s) => s.kind === "author").map((s) => s.name)).toEqual(["Ana Lucia Ortega", "Tom B.", "Mei Sato", "Chidi O.", "Northbound Staff"]);
    // "Porto" is used by a published post too; the draft's own terms don't count twice.
    expect(src("tag:110")).toMatchObject({ name: "Porto", posts: 1 });
    expect(src("category:1")).toMatchObject({ name: "Uncategorized", posts: 2 });
  });
});

describe("rank fusion", () => {
  it("rewards agreement between lists over one list's top hit", () => {
    const s = rrf([
      ["a", "b", "c"],
      ["b", "c", "a"],
    ]);
    expect([...s].sort((x, y) => y[1] - x[1]).map(([id]) => id)).toEqual(["b", "a", "c"]);
  });

  it("keeps candidates found by only one search, with the other rank empty", () => {
    const c = fuse([{ entryId: "topic-food", similarity: 0.71 }], [{ entryId: "topic-rail" }], byId);
    expect(c.map((x) => [x.entryId, x.vectorRank, x.keywordRank])).toEqual([
      ["topic-food", 1, null],
      ["topic-rail", null, 1],
    ]);
  });
});

describe("rules", () => {
  it("links the same name across accents and punctuation", () => {
    expect(ruleDecision(src("author:2"), [cand("author-ortiz"), cand("author-ortega", 2)])).toMatchObject({ decision: "link", entryId: "author-ortega", decidedBy: "rule" });
  });

  it("skips WordPress's default category and leaves the rest to judgement", () => {
    expect(ruleDecision(src("category:1"), [])).toMatchObject({ decision: "skip", decidedBy: "rule" });
    expect(ruleDecision(src("author:3"), [cand("author-brennan"), cand("author-brenner")])).toBeNull();
  });
});

describe("checking Claude's decisions", () => {
  const tom = src("author:3");
  const cands = [cand("author-brennan"), cand("author-brenner", 2)];
  const d = (x: Partial<LinkDecision>) => ({ source: tom.key, decision: "link" as const, entryId: "author-brennan", reason: "r", evidence: "mountain guide", ...x });

  it("accepts a link to a retrieved candidate with real evidence", () => {
    expect(checkDecision(tom, cands, d({}))).toEqual([]);
  });

  it("rejects an entry that wasn't retrieved for this item, and invented evidence", () => {
    expect(checkDecision(tom, cands, d({ entryId: "author-sato" }))).toContain("author-sato wasn't among the candidates retrieved for Tom B.");
    expect(checkDecision(tom, cands, d({ evidence: "led tours in Nepal" }))).toEqual(['The evidence "led tours in Nepal" isn\'t in the source or the chosen entry']);
  });

  it("rejects inconsistent decisions and new topics from tags", () => {
    expect(checkDecision(tom, cands, d({ decision: "skip" }))).toContain('"skip" can\'t name an entry');
    expect(checkDecision(src("tag:102"), [], { source: "tag:102", decision: "new", entryId: null, reason: "", evidence: "Alps" })).toEqual(["Tags don't become new topics; skip or link"]);
  });

  it("limits the schema's entry ids to the batch's candidates", () => {
    const schema = decisionSchema(["author:3"], ["author-brennan"]);
    expect(schema.safeParse({ decisions: [{ source: "author:3", decision: "link", entryId: "author-sato", reason: "", evidence: "" }] }).success).toBe(false);
  });
});

describe("topic links for a post", () => {
  it("puts categories first, drops duplicates and caps at the field's limit", () => {
    const post = source.posts.find((p) => p.id === 1201)!; // Eating Out; Lisbon, pastries, cheap eats
    const decisions = new Map<string, LinkDecision>(
      [
        ["category:10", "topic-food"],
        ["tag:100", "topic-portugal"],
        ["tag:101", "topic-food"],
        ["tag:106", "topic-budget"],
      ].map(([k, id]) => [k!, { source: k!, decision: "link", entryId: id!, reason: "", evidence: "", decidedBy: "rule" }]),
    );
    expect(topicLinksFor(post, decisions, 2)).toEqual({ ids: ["topic-food", "topic-portugal"], dropped: ["cheap eats"] });
  });

  it("links a new topic to the id stage 04 will create", () => {
    expect(newEntryId("topic", "trekking")).toBe("topic-new-trekking");
  });
});

describe("hashing embedder", () => {
  it("is deterministic, unit length, and finds spelling variants", () => {
    const a = hashingEmbed("Ana Lucia Ortega");
    expect(hashingEmbed("Ana Lucia Ortega")).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 4);
    expect(cos(a, hashingEmbed("Ana-Lucía Ortega"))).toBeGreaterThan(0.99);
    expect(cos(a, hashingEmbed("Ana Ortiz"))).toBeLessThan(cos(a, hashingEmbed("Ana-Lucía Ortega")));
  });

  it("knows nothing about meaning (why a real embedding model is needed)", () => {
    expect(cos(hashingEmbed("Eating Out"), hashingEmbed("Food & Drink"))).toBeLessThan(0.2);
  });
});
