import { describe, expect, it } from "vitest";
import { validateRichTextDocument, type Block, type Document } from "@contentful/rich-text-types";
import exportJson from "../../samples/northbound-export.json";
import modelJson from "../../samples/contentful-model.json";
import { migratable, parseExport, wpGmtToIso } from "./source";
import { contentType, parseModel, richTextRules, validateEntry, type EntryDraft, type Link } from "./model";
import { htmlToRichText, documentText, stableId, type TransformOptions } from "./richtext";
import { bodyPreserved, ungrounded, visibleText } from "./grounding";
import { convertBody } from "./convert";

const source = parseExport(exportJson);
const model = parseModel(modelJson);
const SITE = "https://northbound.example";
const article = contentType(model, "article");
const bodyField = article.fields.find((f) => f.id === "body")!;
const opts: TransformOptions = { siteOrigin: SITE, knownSlugs: new Set(source.posts.map((p) => p.slug)), ...richTextRules(bodyField) };
const post = (id: number) => source.posts.find((p) => p.id === id)!;
const convert = (id: number) => convertBody(post(id), source, model, SITE);
const types = (doc: Document) => doc.content.map((n) => n.nodeType);

describe("source export", () => {
  it("reads WordPress GMT dates as UTC and treats the zero date as unpublished", () => {
    expect(wpGmtToIso("2022-03-31T23:00:00")).toBe("2022-03-31T23:00:00.000Z");
    expect(wpGmtToIso("0000-00-00T00:00:00")).toBeNull();
    expect(wpGmtToIso("2019-02-31T10:00:00")).toBeNull();
  });

  it("decodes entities, resolves authors, terms and featured media", () => {
    const p = post(1201);
    expect(p.title).toBe("The Best Pastéis de Nata in Lisbon (2019 Edition)");
    expect(p.author?.name).toBe("Ana Lucia Ortega");
    expect(p.terms.map((t) => t.name)).toEqual(["Eating Out", "Lisbon", "pastries", "cheap eats"]);
    expect(p.featured?.alt).toBe("A tray of custard tarts with blistered tops");
    expect(post(1203).featured).toBeNull();
  });

  it("only migrates published posts", () => {
    expect(migratable(post(1210))).toEqual({ ok: false, reason: 'status is "draft"' });
    expect(source.posts.filter((p) => migratable(p).ok)).toHaveLength(9);
  });
});

describe("HTML → Rich Text on every sample post", () => {
  const published = source.posts.filter((p) => migratable(p).ok);

  it.each(published.map((p) => [p.slug, p.id] as const))("%s: valid for Contentful, nothing lost or added", (_, id) => {
    const c = convert(id);
    expect(validateRichTextDocument(c.document)).toEqual([]);
    const resolve = (l: Link) => (l.sys.linkType === "Asset" ? "asset" : l.sys.id.startsWith("video-") ? "videoEmbed" : "article");
    const problems = validateEntry({ contentType: "article", id: "x", fields: { body: c.document } }, article, resolve).filter((p) => p.field === "body");
    expect(problems).toEqual([]);
    expect(c.check).toEqual({ ok: true, missing: [], added: [] });
  });
});

describe("HTML → Rich Text cases", () => {
  it("turns a [caption] shortcode into an embedded asset and keeps the caption for the asset", () => {
    const c = convert(1201);
    expect(types(c.document)).toEqual(["paragraph", "embedded-asset-block", "heading-2", "paragraph", "heading-2", "ordered-list", "paragraph", "paragraph"]);
    expect(c.assets).toEqual([{ id: stableId("asset", "https://img.northbound.example/2019/04/pasteis-tray.jpg"), url: "https://img.northbound.example/2019/04/pasteis-tray.jpg", alt: "A tray of custard tarts with blistered tops", caption: "Fresh from the oven at 7am." }]);
    expect(c.movedText).toEqual(["Fresh from the oven at 7am."]);
    expect(c.warnings).toEqual([]);
  });

  it("drops empty &nbsp; paragraphs and keeps marks", () => {
    const first = convert(1201).document.content[0]!;
    expect(first.content.map((n) => ("value" in n ? [n.value, n.marks.map((m) => m.type)] : null))).toEqual([
      ["Every bakery in Lisbon sells ", []],
      ["pastéis de nata", ["bold"]],
      [". Most are fine. A few are worth crossing the city for, and over three days we ate forty of them to find out which.", []],
    ]);
    expect(convert(1207).document.content.every((n) => documentText(n).trim() !== "" || n.nodeType.startsWith("embedded"))).toBe(true);
  });

  it("splits <br><br> runs into paragraphs, nests lists, links known posts as entries", () => {
    const c = convert(1202);
    expect(types(c.document)).toEqual(["paragraph", "paragraph", "heading-3", "paragraph", "heading-3", "unordered-list", "blockquote", "paragraph"]);
    const list = c.document.content[5]!;
    const third = list.content[2] as Block;
    expect(third.content.map((n) => n.nodeType)).toEqual(["paragraph", "unordered-list"]);
    expect(c.entryLinks).toEqual(["four-day-loop-above-chamonix"]);
  });

  it("resolves a relative link to another post", () => {
    const c = convert(1203);
    expect(c.entryLinks).toEqual(["hut-to-hut-alps-first-timers"]);
    const table = c.document.content.find((n) => n.nodeType === "table")!;
    expect(table.content).toHaveLength(5);
    expect((table.content[0] as Block).content.map((n) => n.nodeType)).toEqual(Array(4).fill("table-header-cell"));
  });

  it("drops scripts with a warning, embeds YouTube as a video entry, unwraps divs", () => {
    const c = convert(1204);
    expect(c.warnings).toEqual([{ code: "script-removed", detail: "<script>" }]);
    expect(c.videos).toEqual([{ id: stableId("video", "https://www.youtube.com/embed/aBcD3fGh1jK"), url: "https://www.youtube.com/embed/aBcD3fGh1jK", title: "Night train from Vienna to Venice" }]);
    expect(types(c.document)).toContain("embedded-entry-block");
    expect(types(c.document)[0]).toBe("paragraph");
  });

  it("removes plugin shortcodes and HTML comments with a warning", () => {
    expect(convert(1205).warnings).toEqual([{ code: "shortcode-removed", detail: '[newsletter_signup list="rail"]' }]);
    expect(convert(1209).warnings).toEqual([{ code: "comment-removed", detail: "TODO: add opening hours table" }]);
  });

  it("clamps headings to the ones the field allows", () => {
    const c = htmlToRichText("<h1>Title</h1><h5>Small</h5><p>x</p>", opts);
    expect(types(c.document)).toEqual(["heading-2", "heading-4", "paragraph"]);
    expect(c.warnings.map((w) => w.detail)).toEqual(["h1 → heading-2", "h5 → heading-4"]);
  });

  it("degrades gracefully when the field doesn't allow tables or a mark", () => {
    const c = htmlToRichText("<table><tr><td>a</td></tr></table><p><s>gone</s> <sup>kept</sup></p>", {
      ...opts,
      enabledNodeTypes: new Set([...opts.enabledNodeTypes].filter((t) => t !== "table")),
      enabledMarks: new Set(["bold"]),
    });
    expect(c.warnings).toContainEqual({ code: "unsupported-block", detail: "table → paragraphs" });
    expect(documentText(c.document)).toBe("gone kept");
  });

  it("keeps a single <br> as a line break", () => {
    const c = htmlToRichText("<p>Open daily<br>8am to 8pm</p>", opts);
    expect(documentText(c.document)).toBe("Open daily\n8am to 8pm");
  });
});

describe("guardrails", () => {
  it("catches a lost sentence and an added word, but not moved captions", () => {
    const src = "One two three. Four five six.";
    expect(bodyPreserved(src, "One two three.")).toMatchObject({ ok: false, missing: ["four five six"] });
    expect(bodyPreserved(src, "One two three. Four five six seven.")).toMatchObject({ ok: false, added: ["seven"] });
    expect(bodyPreserved("Intro. Caption here. Outro.", "Intro. Outro.", ["Caption here."]).ok).toBe(true);
  });

  it("extracts visible text without scripts, comments or shortcode tags", () => {
    expect(visibleText('<p>a <!-- no --></p><script>x()</script>[caption id="1"]<img/> b[/caption]')).toBe("a b");
  });

  it("flags numbers and names a generated summary didn't get from the source", () => {
    const src = visibleText(post(1201).html);
    expect(ungrounded("Six Lisbon bakeries, with tarts from €1.10.", src)).toEqual([]);
    expect(ungrounded("Confeitaria Nacional, founded in 1830.", src)).toEqual(["1830"]);
    expect(ungrounded("The best tarts in Porto.", src)).toEqual(["Porto"]);
  });

  it("doesn't take a sentence's first word for a name (regression: 'Planning' was rejected)", () => {
    const src = `${post(1202).title}\n${visibleText(post(1202).html)}`;
    expect(ungrounded("Planning your first hut-to-hut walk in the Alps? Book early.", src)).toEqual([]);
    expect(ungrounded("Walks from Zermatt and the Alps.", src)).toEqual(["Zermatt"]);
  });
});

describe("entry validation", () => {
  const ok = (l: Link) => (l.sys.id.startsWith("author") ? "author" : l.sys.id.startsWith("topic") ? "topic" : l.sys.linkType === "Asset" ? "asset" : null);
  const link = (id: string, linkType: "Entry" | "Asset" = "Entry"): Link => ({ sys: { type: "Link", linkType, id } });
  const base: EntryDraft = {
    contentType: "article",
    id: "a",
    fields: {
      title: "Title",
      slug: "a-title",
      publishedAt: "2020-01-01T00:00:00.000Z",
      summary: "A summary that is long enough to pass the minimum length rule.",
      body: convert(1206).document,
      author: link("author-x"),
    },
  };
  const problems = (fields: EntryDraft["fields"]) => validateEntry({ ...base, fields: { ...base.fields, ...fields } }, article, ok).map((p) => p.message);

  it("accepts a complete draft", () => {
    expect(problems({})).toEqual([]);
  });

  it("reports each rule the way an editor would read it", () => {
    expect(problems({ title: "" })).toEqual(["Title is required"]);
    expect(problems({ summary: "Too short." })).toEqual(["Summary is 10 characters; the minimum is 40"]);
    expect(problems({ slug: "Bad Slug" })).toEqual(["Slug doesn't match ^[a-z0-9]+(?:-[a-z0-9]+)*$"]);
    expect(problems({ publishedAt: "2020-01-01T00:00:00" })).toEqual(["Published at must carry a time zone (store UTC)"]);
    expect(problems({ author: link("topic-x") })).toEqual(["Author must link author, not topic"]);
    expect(problems({ author: link("ghost") })).toEqual(["Author links ghost, which doesn't exist"]);
    expect(problems({ region: "Mars" })).toEqual(["Region must be one of: Europe, Asia, Africa, Americas, Oceania"]);
    expect(problems({ topics: [link("topic-a"), link("topic-a")] })).toEqual(["Topics links the same entry twice"]);
    expect(problems({ colour: "red" })).toEqual(['"colour" is not a field of Article']);
  });

  it("rejects rich-text nodes the field doesn't enable", () => {
    const doc = htmlToRichText("<h1>x</h1>", { ...opts, enabledNodeTypes: new Set(["heading-1"]) }).document;
    expect(problems({ body: doc })).toEqual(["Body: heading-1 isn't enabled in this field"]);
  });
});
