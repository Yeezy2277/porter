import { describe, expect, it } from "vitest";
import exportJson from "../../samples/northbound-export.json";
import modelJson from "../../samples/contentful-model.json";
import goldenJson from "../../samples/golden/mapping-article.json";
import { applyMapping, checkMapping, describeForPrompt, Mapping, type ApplyContext } from "./mapping";
import { contentType, parseModel, validateEntry, type Link } from "./model";
import { parseExport, plainText } from "./source";
import { convertBody } from "./convert";
import { stableId } from "./text";

const source = parseExport(exportJson);
const model = parseModel(modelJson);
const article = contentType(model, "article");
const golden = Mapping.parse(goldenJson);
const post = (id: number) => source.posts.find((p) => p.id === id)!;
const resolve = (l: Link) => (l.sys.linkType === "Asset" ? "asset" : null);
const ctx: ApplyContext = { richText: (p) => convertBody(p, source, model, "https://northbound.example").document, plainText, resolve };
const edit = (target: string, change: Partial<Mapping["fields"][number]>): Mapping => ({ ...golden, fields: golden.fields.map((f) => (f.target === target ? { ...f, ...change } : f)) });

describe("checkMapping", () => {
  it("accepts the reference mapping", () => {
    expect(checkMapping(golden, article)).toEqual([]);
  });

  it("refuses a required field left empty", () => {
    expect(checkMapping(edit("author", { transform: "none", sources: [] }), article)).toEqual([{ target: "author", severity: "error", message: "Author is required but not mapped" }]);
  });

  it("refuses a transform that can't fill the field or read the source", () => {
    const msgs = (m: Mapping) => checkMapping(m, article).map((p) => p.message);
    expect(msgs(edit("publishedAt", { transform: "copy" }))).toContain('Mapping: "copy" can\'t fill a Date field');
    expect(msgs(edit("title", { sources: ["post.author"] }))).toContain('Mapping: "copy" can\'t read post.author (author)');
    expect(msgs(edit("body", { transform: "generate" }))).toContain('Mapping: "generate" can\'t fill a RichText field');
  });

  it("refuses unknown and duplicate targets", () => {
    const m: Mapping = { ...golden, fields: [...golden.fields, { ...golden.fields[0]!, target: "title" }, { ...golden.fields[0]!, target: "subtitle" }] };
    expect(checkMapping(m, article).map((p) => p.message)).toEqual(['"title" is mapped 2 times', 'Article has no field "subtitle"']);
  });
});

describe("applyMapping", () => {
  it("builds a draft whose filled fields pass the content type's rules", () => {
    const { draft, pending } = applyMapping(golden, article, post(1201), ctx);
    expect(draft.id).toBe("article-the-best-pasteis-de-nata-in-lisbon-2019");
    expect(draft.fields).toMatchObject({
      title: "The Best Pastéis de Nata in Lisbon (2019 Edition)",
      slug: "the-best-pasteis-de-nata-in-lisbon-2019",
      publishedAt: "2019-04-12T08:30:00.000Z",
      heroImage: { sys: { type: "Link", linkType: "Asset", id: stableId("asset", "https://img.northbound.example/2019/04/pasteis-tray.jpg") } },
    });
    expect(pending.map((p) => p.target)).toEqual(["author", "topics", "region"]);
    const waiting = new Set(pending.map((p) => p.target));
    expect(validateEntry(draft, article, resolve).filter((p) => !waiting.has(p.field))).toEqual([]);
  });

  it("falls back when the source is empty", () => {
    const { draft, pending, usedFallback } = applyMapping(golden, article, post(1203), ctx);
    expect(draft.fields.summary).toBeUndefined();
    expect(usedFallback).toContain("summary");
    expect(pending).toContainEqual({ target: "summary", transform: "generate", sources: ["post.title", "post.content"] });
  });

  it("falls back when the source breaks the field's rules (an excerpt under 40 characters)", () => {
    expect(post(1205).excerpt).toBe("How to make a rail pass go further.");
    const { usedFallback } = applyMapping(golden, article, post(1205), ctx);
    expect(usedFallback).toContain("summary");
  });

  it("keeps a valid source over generated text", () => {
    const { draft, usedFallback } = applyMapping(golden, article, post(1201), ctx);
    expect(draft.fields.summary).toBe("We ate forty custard tarts in three days so you don’t have to. Here are the six worth crossing the city for.");
    expect(usedFallback).not.toContain("summary");
  });
});

describe("prompt context", () => {
  it("shows the model real sample values and every target rule", () => {
    const d = describeForPrompt(source.posts.slice(0, 3), article);
    expect(d.sources).toContain('post.excerpt (text): Excerpt. Samples: "We ate forty custard tarts');
    expect(d.target).toContain("summary (Symbol, required): Summary. Rules: size 40..200");
    expect(d.target).toContain("topics (EntryLinks): Topics. Rules: size 0..4; links topic");
    expect(d.transforms).toContain("generate: Written from the sources");
  });
});
